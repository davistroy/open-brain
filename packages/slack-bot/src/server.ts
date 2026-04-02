/**
 * Slack Bot entry point — creates Bolt app, registers handlers, starts Socket Mode connection.
 * Called by index.ts after environment validation.
 */

import type { App } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { Redis } from 'ioredis'
import type { CoreApiClient } from './lib/core-api-client.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { logger, type AutonomyLevel } from '@open-brain/shared'
import { IntentRouter } from './intent/router.js'
import { handleCapture } from './handlers/capture.js'
import { handleQuery } from './handlers/query.js'
import { handleCommand } from './handlers/command.js'
import { handleSessionThreadReply, getSessionThread } from './handlers/session.js'
import { getThreadContext } from './lib/thread-context.js'
import { safeHandle } from './lib/safe-handle.js'
import { isAutoResponseCandidate, handleAutoResponse, type AutoResponseConfig } from './handlers/auto-response.js'

/** Cache for autonomy level -- refreshed every 5 minutes */
let cachedAutonomyLevel: { level: AutonomyLevel; fetchedAt: number } | null = null
const AUTONOMY_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function getAutonomyLevel(coreApiClient: CoreApiClient): Promise<AutonomyLevel> {
  const now = Date.now()
  if (cachedAutonomyLevel && now - cachedAutonomyLevel.fetchedAt < AUTONOMY_CACHE_TTL) {
    return cachedAutonomyLevel.level
  }

  try {
    const response = await fetch(
      `${process.env.CORE_API_URL ?? 'http://core-api:3000'}/api/v1/settings/autonomy_level`,
    )
    if (response.ok) {
      const data = (await response.json()) as { value: string }
      const level = (['observe', 'assist', 'advise', 'partner'].includes(data.value)
        ? data.value
        : 'observe') as AutonomyLevel
      cachedAutonomyLevel = { level, fetchedAt: now }
      return level
    }
  } catch {
    // Settings not available -- default to observe
  }

  cachedAutonomyLevel = { level: 'observe', fetchedAt: now }
  return 'observe'
}

/**
 * Register all message/event handlers on the Bolt app.
 */
function registerHandlers(app: App, coreApiClient: CoreApiClient, redis: Redis): void {
  // Resolve intent model alias from ai-routing.yaml — OpenAI API rejects alias strings.
  // Load only ai-routing.yaml (not full ConfigService) since slack-bot doesn't mount all config files.
  let intentModel = 'gpt-5.4' // safe fallback
  const configDir = process.env.CONFIG_DIR ?? '/app/config'
  const aiConfigPath = join(configDir, 'ai-routing.yaml')
  if (existsSync(aiConfigPath)) {
    try {
      const raw = yaml.load(readFileSync(aiConfigPath, 'utf8')) as Record<string, unknown>
      const models = raw?.models as Record<string, string> | undefined
      if (models?.intent) intentModel = models.intent
    } catch (err) {
      logger.warn({ err }, 'Failed to load ai-routing.yaml — using default intent model')
    }
  } else {
    logger.info({ path: aiConfigPath }, 'ai-routing.yaml not found — using default intent model')
  }

  // Build IntentRouter from environment — falls back to CAPTURE if LiteLLM unavailable
  const litellmUrl = process.env.LITELLM_URL ?? 'https://llm.k4jda.net'
  const litellmApiKey = process.env.LITELLM_API_KEY ?? ''
  const intentRouter = new IntentRouter({
    litellm_url: litellmUrl,
    litellm_api_key: litellmApiKey,
    intent_model: intentModel,
    llm_timeout_ms: 5_000,
  })

  // Auto-response configuration
  const autoResponseConfig: AutoResponseConfig = {
    coreApiUrl: process.env.CORE_API_URL ?? 'http://core-api:3000',
    confidenceThreshold: 0.6,
    stalenessDays: 90,
    minCorroboratingResults: 2,
    botUserId: undefined, // Set after app.start() if available
    ownerUserId: process.env.SLACK_OWNER_USER_ID,
  }

  // Ignore bot messages globally — prevents feedback loops
  app.message(async ({ message, next }) => {
    if ('subtype' in message && message.subtype === 'bot_message') {
      return
    }
    if ('bot_id' in message && message.bot_id) {
      return
    }
    await next()
  })

  // Primary message handler — routes via IntentRouter
  app.message(async ({ message, say }) => {
    if (!('text' in message) || !message.text) return

    const genericMessage = message as GenericMessageEvent
    const ts = genericMessage.ts

    await safeHandle(async () => {
      const text = genericMessage.text ?? ''
      const channel = genericMessage.channel
      const threadTs = ('thread_ts' in message && message.thread_ts) ? message.thread_ts as string : null

      logger.info({ channel, ts, textLen: text.length }, 'Received message')

      // If this is a thread reply, check whether it belongs to an active governance session
      // or an existing search thread. Both bypass IntentRouter entirely.
      if (threadTs && threadTs !== ts) {
        const sessionId = await getSessionThread(redis, threadTs)
        if (sessionId) {
          // Governance thread reply — but still allow !board <pause|done|abandon> through
          logger.debug({ threadTs, sessionId }, 'Routing to governance session handler')
          await handleSessionThreadReply(genericMessage, say, coreApiClient, redis, sessionId)
          return
        }

        // Check if this is a reply to a search thread (has stored query context)
        const queryCtx = await getThreadContext(redis, threadTs)
        if (queryCtx?.query !== undefined) {
          logger.debug({ threadTs }, 'Routing to query handler (search thread follow-up)')
          await handleQuery(genericMessage, say, coreApiClient, redis)
          return
        }
      }

      // Classify intent
      const intentResult = await intentRouter.classify(text, {
        channel_id: channel,
        is_thread_reply: 'thread_ts' in message && !!message.thread_ts,
        is_mention: false,
      })

      logger.debug(
        { intent: intentResult.intent, confidence: intentResult.confidence, method: intentResult.method },
        'Intent classified',
      )

      switch (intentResult.intent) {
        case 'capture':
          await handleCapture(genericMessage, say, coreApiClient)
          break

        case 'query':
          await handleQuery(genericMessage, say, coreApiClient, redis)
          break

        case 'command':
          await handleCommand(genericMessage, say, coreApiClient, redis)
          break

        case 'conversation':
          // Conversational messages acknowledged but not captured
          logger.debug({ channel, ts }, 'Conversational message — no action taken')
          break

        default:
          // Safety net — treat unknown intents as capture
          await handleCapture(genericMessage, say, coreApiClient)
          break
      }

      // --- Auto-response (async, fire-and-forget) ---
      // For messages that aren't directed at the bot, check if they're
      // questions Open Brain could answer. Runs in background.
      if (
        intentResult.intent === 'conversation' ||
        intentResult.intent === 'capture'
      ) {
        if (isAutoResponseCandidate(genericMessage, autoResponseConfig)) {
          getAutonomyLevel(coreApiClient).then(level => {
            handleAutoResponse(genericMessage, app, coreApiClient, level, autoResponseConfig)
          }).catch(err => {
            logger.debug({ err }, '[auto-response] skipped — failed to get autonomy level')
          })
        }
      }
    }, say, ts)
  })

  // App mention handler — `@Open Brain ...` → QUERY, `@Open Brain !cmd` → COMMAND
  app.event('app_mention', async ({ event, say }) => {
    logger.info({ channel: event.channel, ts: event.ts }, 'App mention received')

    // Strip the leading @mention so we can inspect the actual content
    const textAfterMention = (event.text ?? '').replace(/^<@[A-Z0-9]+>\s*/i, '').trim()

    const syntheticMessage = {
      type: 'message' as const,
      subtype: undefined,
      channel: event.channel,
      ts: event.ts,
      text: event.text,
      user: event.user,
      thread_ts: event.thread_ts,
    } as unknown as GenericMessageEvent

    if (textAfterMention.startsWith('!')) {
      // `@Open Brain !command` — route to command handler with mention stripped
      const commandMessage = { ...syntheticMessage, text: textAfterMention } as unknown as GenericMessageEvent
      await handleCommand(commandMessage, say, coreApiClient, redis)
    } else {
      await handleQuery(syntheticMessage, say, coreApiClient, redis)
    }
  })

  logger.info('Slack bot handlers registered')
}

/**
 * Start the Bolt app and connect via Socket Mode.
 */
export async function startServer(app: App, coreApiClient: CoreApiClient): Promise<void> {
  // Build Redis client for thread context storage
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 })

  registerHandlers(app, coreApiClient, redis)

  await app.start()
  logger.info('Slack bot connected via Socket Mode')
}
