import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import { formatError } from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

export async function handleBriefGenerate(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  // Acknowledge immediately — brief generation can take 30-60 seconds
  await say({ text: '_Generating weekly brief… this may take a minute._', thread_ts: ts })

  try {
    const result = await client.skills_trigger('weekly-brief')
    const status = result.queued
      ? 'Weekly brief queued for generation. You will be notified when it is ready.'
      : 'Weekly brief triggered.'
    await say({ text: status, thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: skills_trigger(weekly-brief) failed')
    await say({ text: formatError('Brief generation failed', err), thread_ts: ts })
  }
}

export async function handleBriefLast(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const log = await client.skills_last_run('weekly-brief')
    if (!log) {
      await say({ text: '_No weekly brief has been generated yet._', thread_ts: ts })
      return
    }
    const lines = [
      `*Last Weekly Brief* — ${new Date(log.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      `Status: ${log.status}  |  Captures queried: ${log.captures_queried ?? 'n/a'}  |  Duration: ${log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : 'n/a'}`,
      log.result_summary ? `\n${log.result_summary}` : '',
    ].filter(Boolean).join('\n')
    await say({ text: lines, thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: skills_last_run failed')
    await say({ text: formatError('Could not retrieve last brief', err), thread_ts: ts })
  }
}
