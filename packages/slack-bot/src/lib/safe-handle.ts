/**
 * Error safety wrapper for Slack handler functions.
 * Catches unhandled errors and reports them as user-facing messages.
 */

import { logger } from '@open-brain/shared'
import { formatError } from './formatters.js'

type SayFn = (msg: string | { text: string; thread_ts?: string }) => Promise<unknown>

export async function safeHandle(
  fn: () => Promise<void>,
  say: SayFn,
  threadTs?: string,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    logger.error({ err }, 'Unhandled handler error')
    try {
      await say({ text: formatError('Something went wrong', err), thread_ts: threadTs })
    } catch { /* swallow double-fault */ }
  }
}
