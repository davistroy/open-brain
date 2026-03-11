import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import { formatError } from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

/**
 * Handle `!drift` — trigger the drift-monitor skill.
 *
 * No arguments — the skill uses its own defaults for analysis windows.
 */
export async function handleDriftCommand(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
): Promise<void> {
  // Acknowledge immediately — skill runs asynchronously
  await say({
    text: '_Running drift analysis…_',
    thread_ts: ts,
  })

  try {
    const result = await client.skills_trigger('drift-monitor', {})
    const status = result.queued
      ? `Drift analysis queued (job \`${result.job_id}\`). Results will arrive via Pushover.`
      : 'Drift analysis triggered.'
    await say({ text: status, thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: skills_trigger(drift-monitor) failed')
    await say({ text: formatError('Drift analysis failed', err), thread_ts: ts })
  }
}
