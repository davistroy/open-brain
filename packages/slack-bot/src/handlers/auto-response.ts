/**
 * Auto-response handler -- processes channel messages that look like questions
 * Open Brain could answer.
 *
 * Three modes based on autonomy level:
 * - observe: Shadow mode -- classify, search, synthesize, LOG but never post
 * - assist: DM mode -- send Pushover/DM with draft when confidence > threshold
 * - advise: Threaded reply -- post attributed response in channel thread
 *
 * This handler runs ASYNCHRONOUSLY after normal message routing.
 * It must NEVER block or interfere with existing capture/query/command handling.
 *
 * PRD guardrails for advise mode (threaded replies):
 * - confidence >= 0.85
 * - minCorroboratingResults >= 2
 * - staleness <= 90 days
 * - skip bot users (bot_id or subtype === 'bot_message')
 * - skip nested thread replies (thread_ts !== ts)
 * - per-channel monitoring (when configured, skip unmonitored channels)
 */

import type { GenericMessageEvent } from '@slack/types'
import type { App } from '@slack/bolt'
import type { CoreApiClient } from '../lib/core-api-client.js'
import type { SearchResult } from '../lib/core-api-types.js'
import { scoreConfidence } from '../services/confidence-scorer.js'
import { formatAttributedResponse } from '../services/attribution-formatter.js'
import { logger, PushoverService, type AutonomyLevel, meetsAutonomyLevel } from '@open-brain/shared'
import { buildDraftDMBlocks, type DraftDMContext } from '../services/dm-blocks.js'

/** Lazy-initialized PushoverService singleton for auto-response notifications */
let _pushover: PushoverService | null = null
function getPushover(): PushoverService {
  if (!_pushover) _pushover = new PushoverService({ onError: 'swallow' })
  return _pushover
}

/** Minimum message length to consider for auto-response */
const MIN_MESSAGE_LENGTH = 15

/** Minimum confidence for advise-mode threaded replies (PRD guardrail) */
export const ADVISE_CONFIDENCE_THRESHOLD = 0.85

/** Minimum confidence for assist-mode DM delivery (channel questions) */
export const ASSIST_CHANNEL_CONFIDENCE_THRESHOLD = 0.75

/** Minimum confidence for assist-mode DM delivery (DM questions) */
export const ASSIST_DM_CONFIDENCE_THRESHOLD = 0.90

/** Question patterns -- more conservative than IntentRouter's patterns */
const AUTO_RESPONSE_QUESTION_PATTERNS = [
  /^(what|who|when|where|why|how|which)\s/i,
  /\?\s*$/,
  /^(does anyone know|can someone|has anyone|do we|did we|is there|are there)\s/i,
]

/** Cache for monitored channels list -- refreshed every 5 minutes */
let _monitoredChannelsCache: { channels: string[] | null; fetchedAt: number } | null = null
const MONITORED_CHANNELS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Fetch the monitored channels list from app_settings.
 * Returns null if no setting exists (meaning: monitor all channels).
 * Returns an array of channel IDs if configured (meaning: only monitor these).
 */
export async function getMonitoredChannels(coreApiUrl: string): Promise<string[] | null> {
  const now = Date.now()
  if (_monitoredChannelsCache && now - _monitoredChannelsCache.fetchedAt < MONITORED_CHANNELS_CACHE_TTL) {
    return _monitoredChannelsCache.channels
  }

  try {
    const response = await fetch(
      `${coreApiUrl}/api/v1/settings/monitored_channels`,
    )
    if (response.ok) {
      const data = (await response.json()) as { value: unknown }
      if (Array.isArray(data.value) && data.value.every((v: unknown) => typeof v === 'string')) {
        _monitoredChannelsCache = { channels: data.value as string[], fetchedAt: now }
        return _monitoredChannelsCache.channels
      }
    }
  } catch {
    // Settings not available -- default to monitor all
  }

  _monitoredChannelsCache = { channels: null, fetchedAt: now }
  return null
}

/** Reset the monitored channels cache (for testing) */
export function _resetMonitoredChannelsCache(): void {
  _monitoredChannelsCache = null
}

export interface AutoResponseConfig {
  /** Core API base URL */
  coreApiUrl: string
  /** Confidence threshold for delivery (DM/threaded). Default: 0.6 */
  confidenceThreshold: number
  /** Staleness window in days for threaded replies. Default: 90 */
  stalenessDays: number
  /** Minimum corroborating results for threaded reply. Default: 2 */
  minCorroboratingResults: number
  /** Bot user ID (to filter out own messages) */
  botUserId?: string
  /** Owner user ID (skip auto-response for owner messages) */
  ownerUserId?: string
}

/**
 * Check if a message is a bot message.
 * Detects bot_id presence or bot_message subtype.
 */
export function isBotMessage(message: GenericMessageEvent): boolean {
  // Check for bot_id field (present on all bot-posted messages)
  if ('bot_id' in message && (message as Record<string, unknown>).bot_id) return true
  // Check for bot_message subtype
  if ('subtype' in message && (message as Record<string, unknown>).subtype === 'bot_message') return true
  return false
}

/**
 * Check if a message is a nested thread reply (reply to a reply).
 * A nested reply has thread_ts set AND thread_ts !== ts (it's inside a thread, not the parent).
 */
export function isNestedThreadReply(message: GenericMessageEvent): boolean {
  const threadTs = 'thread_ts' in message ? (message as Record<string, unknown>).thread_ts : undefined
  if (!threadTs) return false
  return threadTs !== message.ts
}

/**
 * Check if a message is a candidate for auto-response.
 * Only classifies questions from OTHER users (not the bot owner).
 * Skips bot messages and nested thread replies.
 */
export function isAutoResponseCandidate(
  message: GenericMessageEvent,
  config: AutoResponseConfig,
): boolean {
  const text = message.text ?? ''

  // Skip short messages
  if (text.length < MIN_MESSAGE_LENGTH) return false

  // Skip own messages and owner messages
  if (config.botUserId && message.user === config.botUserId) return false
  if (config.ownerUserId && message.user === config.ownerUserId) return false

  // Skip bot messages (defense-in-depth -- server.ts also filters these)
  if (isBotMessage(message)) return false

  // Skip nested thread replies (reply to a reply -- prevents thread spam)
  if (isNestedThreadReply(message)) return false

  // Skip messages with command/capture prefixes
  if (text.startsWith('!') || text.startsWith('?')) return false

  // Check question patterns
  return AUTO_RESPONSE_QUESTION_PATTERNS.some(p => p.test(text))
}

/**
 * Handle a potential auto-response. This runs asynchronously and never throws.
 */
export async function handleAutoResponse(
  message: GenericMessageEvent,
  app: App,
  coreApiClient: CoreApiClient,
  autonomyLevel: AutonomyLevel,
  config: AutoResponseConfig,
): Promise<void> {
  const text = message.text ?? ''
  const channel = message.channel
  const ts = message.ts

  try {
    // Step 0: Per-channel monitoring check
    // If monitored_channels is configured, only respond in those channels.
    // Default (null): monitor all channels.
    const monitoredChannels = await getMonitoredChannels(config.coreApiUrl)
    if (monitoredChannels !== null && !monitoredChannels.includes(channel)) {
      logger.debug(
        { channel, monitoredChannels },
        '[auto-response] skipped -- channel not in monitored list',
      )
      return
    }

    // Step 1: Search for relevant captures
    const searchResponse = await coreApiClient.search_query({
      query: text,
      limit: 10,
      search_mode: 'hybrid',
      temporal_weight: 0.1,
    })

    const results: SearchResult[] = searchResponse.results

    // Step 2: Score confidence (pass query text for entity match signal)
    const confidence = scoreConfidence(results, text)

    // Step 3: Synthesize a response (only if we have decent results)
    let synthesis = ''
    if (confidence.composite > 0.2 && results.length > 0) {
      try {
        const synthResponse = await coreApiClient.synthesize_query({
          query: text,
          limit: 10,
        })
        synthesis = synthResponse.response
      } catch (err) {
        logger.warn({ err }, '[auto-response] synthesis failed -- logging without synthesis')
      }
    }

    // Step 4: Format attributed response
    const attributed = synthesis
      ? formatAttributedResponse(synthesis, results)
      : { text: '', summary: 'No synthesis available', sources: [] }

    // Step 5: Log everything (shadow mode -- always happens)
    logger.info(
      {
        channel,
        ts,
        user: message.user,
        queryLength: text.length,
        confidence: confidence.composite,
        factors: confidence,
        resultCount: results.length,
        hasSynthesis: !!synthesis,
        autonomyLevel,
      },
      '[auto-response] shadow log',
    )

    // Step 6: DM/Pushover delivery (assist mode)
    // Confidence thresholds differ by message context:
    //   0.75 for channel messages, 0.90 for DMs
    const isDM = channel.startsWith('D')
    const assistThreshold = isDM ? ASSIST_DM_CONFIDENCE_THRESHOLD : ASSIST_CHANNEL_CONFIDENCE_THRESHOLD
    const effectiveAssistThreshold = Math.max(config.confidenceThreshold, assistThreshold)

    if (
      meetsAutonomyLevel(autonomyLevel, 'assist') &&
      confidence.composite >= effectiveAssistThreshold &&
      synthesis
    ) {
      let dmSent = false

      // Try Slack DM with interactive buttons first
      if (config.ownerUserId) {
        try {
          const dmContext: DraftDMContext = {
            channel,
            threadTs: ts,
            userId: message.user ?? 'unknown',
            draft: attributed.text,
            summary: attributed.summary,
            confidence: confidence.composite,
            sourceCount: confidence.relevantResultCount,
            originalText: text,
          }
          const blocks = buildDraftDMBlocks(dmContext)

          await app.client.chat.postMessage({
            channel: config.ownerUserId,
            text: `Auto-response draft (${(confidence.composite * 100).toFixed(0)}% confidence) for question in <#${channel}>`,
            blocks,
            // Store context in metadata for action handlers
            metadata: {
              event_type: 'auto_response_draft',
              event_payload: {
                channel,
                thread_ts: ts,
                user: message.user,
                draft: attributed.text,
              },
            },
          })

          dmSent = true
          logger.info({ channel, ts, confidence: confidence.composite }, '[auto-response] DM sent with interactive buttons')
        } catch (err) {
          logger.warn({ err }, '[auto-response] DM delivery failed -- falling back to Pushover')
        }
      }

      // Pushover as fallback (or if DM not configured)
      if (!dmSent) {
        try {
          const pushover = getPushover()
          if (pushover.isConfigured) {
            const pushoverMessage = [
              `Channel question from <@${message.user}>:`,
              `"${text.length > 150 ? text.slice(0, 150) + '...' : text}"`,
              '',
              `Draft response (confidence: ${(confidence.composite * 100).toFixed(0)}%):`,
              attributed.summary,
              '',
              `Sources: ${confidence.relevantResultCount} relevant captures`,
            ].join('\n')

            await pushover.send({
              title: 'Open Brain: Auto-Response Draft',
              message: pushoverMessage,
              priority: 0,
            })

            logger.info({ channel, ts, confidence: confidence.composite }, '[auto-response] Pushover sent')
          }
        } catch (err) {
          logger.warn({ err }, '[auto-response] Pushover delivery failed')
        }
      }
    }

    // Step 7: Threaded reply (advise mode)
    // PRD guardrails enforced:
    // - confidence >= ADVISE_CONFIDENCE_THRESHOLD (0.85)
    // - minCorroboratingResults >= 2
    // - staleness <= configured days (default 90)
    // - bot users already filtered in isAutoResponseCandidate
    // - nested thread replies already filtered in isAutoResponseCandidate
    // - per-channel monitoring already checked in Step 0
    const adviseThreshold = Math.max(config.confidenceThreshold, ADVISE_CONFIDENCE_THRESHOLD)
    if (
      meetsAutonomyLevel(autonomyLevel, 'advise') &&
      confidence.composite >= adviseThreshold &&
      synthesis &&
      confidence.relevantResultCount >= config.minCorroboratingResults
    ) {
      // Check staleness
      const now = Date.now()
      const oldestRelevant = results
        .filter(r => r.score > 0.3)
        .reduce((oldest, r) => {
          const age = (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24)
          return Math.max(oldest, age)
        }, 0)

      if (oldestRelevant <= config.stalenessDays) {
        try {
          await app.client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: attributed.text,
          })
          logger.info(
            { channel, ts, confidence: confidence.composite, resultCount: confidence.relevantResultCount },
            '[auto-response] threaded reply posted',
          )
        } catch (err) {
          logger.warn({ err }, '[auto-response] failed to post threaded reply')
        }
      } else {
        logger.debug(
          { oldestRelevant, stalenessDays: config.stalenessDays },
          '[auto-response] skipped -- results too stale',
        )
      }
    }
  } catch (err) {
    // Never throw from auto-response -- it's fire-and-forget
    logger.error({ err, channel, ts }, '[auto-response] unhandled error')
  }
}
