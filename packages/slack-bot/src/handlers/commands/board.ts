import type { SayFn } from '@slack/bolt'
import type { Redis } from 'ioredis'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import {
  formatSessionList,
  formatSessionStart,
  formatError,
} from '../../lib/formatters.js'
import { setSessionThread } from '../session.js'
import { logger } from '../../lib/logger.js'

export async function handleBoardCommand(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  redis: Redis | undefined,
  subCmd: string,
  _subCmdRaw: string,
  args: string,
): Promise<void> {
  switch (subCmd) {
    // -------------------------------------------------------------------------
    // !board quick — start a quick board check session
    // -------------------------------------------------------------------------
    case 'quick': {
      if (!redis) {
        await say({ text: ':warning: Redis unavailable — governance sessions require Redis.', thread_ts: ts })
        return
      }
      try {
        const result = await client.sessions_create('governance')
        // Map the current message ts → session id so thread replies are routed
        await setSessionThread(redis, ts, result.session.id)
        await say({
          text: formatSessionStart(result.session.id, 'quick board check', result.first_message),
          thread_ts: ts,
        })
      } catch (err) {
        logger.error({ err }, 'handleCommand: sessions_create(governance) failed')
        await say({ text: formatError('Could not start governance session', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !board quarterly — start a quarterly review session
    // -------------------------------------------------------------------------
    case 'quarterly': {
      if (!redis) {
        await say({ text: ':warning: Redis unavailable — governance sessions require Redis.', thread_ts: ts })
        return
      }
      try {
        const result = await client.sessions_create('review')
        await setSessionThread(redis, ts, result.session.id)
        await say({
          text: formatSessionStart(result.session.id, 'quarterly review', result.first_message),
          thread_ts: ts,
        })
      } catch (err) {
        logger.error({ err }, 'handleCommand: sessions_create(review) failed')
        await say({ text: formatError('Could not start quarterly review session', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !board resume <id> — resume a paused session
    // -------------------------------------------------------------------------
    case 'resume': {
      // After parseCommand: cmd='board', subCmd='resume', subCmdRaw='resume', args=<session-id...>
      // The session ID is the first token of args.
      const resolvedId = args.trim().split(/\s+/)[0] ?? ''
      if (!resolvedId) {
        await say({ text: ':warning: Usage: `!board resume <session-id>`', thread_ts: ts })
        return
      }
      if (!redis) {
        await say({ text: ':warning: Redis unavailable — governance sessions require Redis.', thread_ts: ts })
        return
      }
      try {
        const result = await client.sessions_resume(resolvedId)
        // Map the new thread (this message's ts) to the resumed session
        await setSessionThread(redis, ts, resolvedId)
        await say({
          text: [
            `:arrow_forward: *Session resumed* (\`${resolvedId.slice(0, 8)}\`)`,
            '',
            `*Board:* ${result.context_message}`,
          ].join('\n'),
          thread_ts: ts,
        })
      } catch (err) {
        logger.error({ err, sessionId: resolvedId }, 'handleCommand: sessions_resume failed')
        await say({ text: formatError('Could not resume session', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    // !board status — list active/paused sessions
    // -------------------------------------------------------------------------
    case 'status': {
      try {
        // Fetch both active and paused sessions
        const [active, paused] = await Promise.all([
          client.sessions_list('active', 10),
          client.sessions_list('paused', 10),
        ])
        const combined = [...active.items, ...paused.items]
        await say({ text: formatSessionList(combined), thread_ts: ts })
      } catch (err) {
        logger.error({ err }, 'handleCommand: sessions_list failed')
        await say({ text: formatError('Could not retrieve sessions', err), thread_ts: ts })
      }
      break
    }

    // -------------------------------------------------------------------------
    default:
      await say({
        text: ':warning: Usage: `!board quick`, `!board quarterly`, `!board resume <id>`, `!board status`',
        thread_ts: ts,
      })
      break
  }
}
