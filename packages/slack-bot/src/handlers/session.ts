/**
 * Session thread handler — routes replies in active governance threads to SessionService.
 *
 * When a user starts a !board quick or !board quarterly session, the bot stores the
 * session ID keyed by thread_ts in Redis (prefix: session_thread:). Subsequent replies
 * in that thread are routed here instead of through IntentRouter.
 *
 * Supported in-thread commands:
 *   !board pause     — pause the active session
 *   !board done      — complete the session and generate summary
 *   !board abandon   — abandon the session
 *   (anything else)  — treated as a user response to the governance conversation
 */

import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import type { Redis } from 'ioredis'
import type { CoreApiClient } from '../lib/core-api-client.js'
import {
  formatSessionPause,
  formatError,
} from '../lib/formatters.js'
import { logger } from '../lib/logger.js'

const SESSION_THREAD_PREFIX = 'session_thread:'
const SESSION_THREAD_TTL = 60 * 60 * 6  // 6 hours — governance sessions don't run longer

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

/**
 * Store a session ID mapped to a Slack thread_ts.
 * Called when !board quick/quarterly creates a new session.
 */
export async function setSessionThread(redis: Redis, threadTs: string, sessionId: string): Promise<void> {
  const key = `${SESSION_THREAD_PREFIX}${threadTs}`
  await redis.set(key, sessionId, 'EX', SESSION_THREAD_TTL)
}

/**
 * Look up the session ID for a given Slack thread_ts.
 * Returns null if not a governance thread or key has expired.
 */
export async function getSessionThread(redis: Redis, threadTs: string): Promise<string | null> {
  const key = `${SESSION_THREAD_PREFIX}${threadTs}`
  return redis.get(key)
}

/**
 * Remove the session thread mapping.
 * Called when session is completed, abandoned, or paused (user must explicitly resume).
 */
export async function deleteSessionThread(redis: Redis, threadTs: string): Promise<void> {
  const key = `${SESSION_THREAD_PREFIX}${threadTs}`
  await redis.del(key)
}

// ---------------------------------------------------------------------------
// Thread reply handler
// ---------------------------------------------------------------------------

/**
 * Handle a reply in an active governance thread.
 *
 * @param message     - Slack GenericMessageEvent (reply in a thread)
 * @param say         - Bolt say() scoped to the channel
 * @param client      - CoreApiClient
 * @param redis       - ioredis client
 * @param sessionId   - The governance session ID for this thread
 */
export async function handleSessionThreadReply(
  message: GenericMessageEvent,
  say: SayFn,
  client: CoreApiClient,
  redis: Redis,
  sessionId: string,
): Promise<void> {
  if (!('text' in message) || !message.text) return

  const text = message.text.trim()
  const ts = message.ts
  // For thread replies, thread_ts is the root message; fall back to ts if top-level
  const threadTs = ('thread_ts' in message && message.thread_ts) ? message.thread_ts as string : ts

  logger.info({ sessionId, threadTs, textLen: text.length }, '[session-handler] handling thread reply')

  // Check for in-thread !board control commands
  if (text.startsWith('!')) {
    const lower = text.toLowerCase().trim()

    if (lower === '!board pause' || lower === '!board pause.') {
      await handleSessionPause(ts, say, client, redis, sessionId, threadTs)
      return
    }

    if (lower === '!board done' || lower === '!board complete') {
      await handleSessionComplete(ts, say, client, redis, sessionId, threadTs)
      return
    }

    if (lower === '!board abandon') {
      await handleSessionAbandon(ts, say, client, redis, sessionId, threadTs)
      return
    }

    // Any other !command in a governance thread — pass through as text (don't capture as command)
    // Fall through to respond
  }

  // Submit user reply to governance engine
  try {
    const result = await client.sessions_respond(sessionId, text)
    await say({ text: `*Board:* ${result.bot_message}`, thread_ts: ts })

    // If session auto-completed (engine decided it's done), clean up thread mapping
    if (result.session.status === 'complete' || result.session.status === 'abandoned') {
      await deleteSessionThread(redis, threadTs)
      if (result.session.status === 'complete' && result.session.summary) {
        await say({
          text: `:white_check_mark: *Session Complete*\n\n${result.session.summary}`,
          thread_ts: ts,
        })
      }
    }
  } catch (err) {
    logger.error({ err, sessionId }, '[session-handler] sessions_respond failed')
    await say({ text: formatError('Governance session error', err), thread_ts: ts })
  }
}

// ---------------------------------------------------------------------------
// Session control sub-handlers
// ---------------------------------------------------------------------------

async function handleSessionPause(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  redis: Redis,
  sessionId: string,
  threadTs: string,
): Promise<void> {
  try {
    const result = await client.sessions_pause(sessionId)
    await deleteSessionThread(redis, threadTs)
    await say({ text: formatSessionPause(result.session), thread_ts: ts })
  } catch (err) {
    logger.error({ err, sessionId }, '[session-handler] sessions_pause failed')
    await say({ text: formatError('Could not pause session', err), thread_ts: ts })
  }
}

async function handleSessionComplete(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  redis: Redis,
  sessionId: string,
  threadTs: string,
): Promise<void> {
  try {
    const result = await client.sessions_complete(sessionId)
    await deleteSessionThread(redis, threadTs)
    await say({ text: `:white_check_mark: *Session Complete*\n\n${result.summary}`, thread_ts: ts })
  } catch (err) {
    logger.error({ err, sessionId }, '[session-handler] sessions_complete failed')
    await say({ text: formatError('Could not complete session', err), thread_ts: ts })
  }
}

async function handleSessionAbandon(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  redis: Redis,
  sessionId: string,
  threadTs: string,
): Promise<void> {
  try {
    await client.sessions_abandon(sessionId)
    await deleteSessionThread(redis, threadTs)
    await say({
      text: ':x: *Session abandoned.* No summary generated.',
      thread_ts: ts,
    })
  } catch (err) {
    logger.error({ err, sessionId }, '[session-handler] sessions_abandon failed')
    await say({ text: formatError('Could not abandon session', err), thread_ts: ts })
  }
}
