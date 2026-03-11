import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import { formatError } from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

/**
 * Handle `!connections [days]` — trigger the daily-connections skill.
 *
 * - `!connections`     → 7-day window (default)
 * - `!connections 14`  → 14-day window
 * - `!connections abc` → error: invalid argument
 */
export async function handleConnectionsCommand(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  subCmd: string,
): Promise<void> {
  // Parse optional day count from first argument
  let windowDays = 7

  if (subCmd) {
    const parsed = parseInt(subCmd, 10)
    if (isNaN(parsed) || parsed < 1) {
      await say({
        text: ':warning: Invalid argument. Usage: `!connections [days]` — days must be a positive number (default: 7)',
        thread_ts: ts,
      })
      return
    }
    windowDays = Math.min(parsed, 90) // Cap at 90 days to prevent excessive queries
  }

  // Acknowledge immediately — skill runs asynchronously
  await say({
    text: `_Running daily connections analysis (last ${windowDays} days)…_`,
    thread_ts: ts,
  })

  try {
    const result = await client.skills_trigger('daily-connections', { windowDays })
    const status = result.queued
      ? `Connections analysis queued (job \`${result.job_id}\`). Results will arrive via Pushover.`
      : 'Connections analysis triggered.'
    await say({ text: status, thread_ts: ts })
  } catch (err) {
    logger.error({ err, windowDays }, 'handleCommand: skills_trigger(daily-connections) failed')
    await say({ text: formatError('Connections analysis failed', err), thread_ts: ts })
  }
}
