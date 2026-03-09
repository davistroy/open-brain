import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import { formatStats, formatRecentCaptures, formatError } from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

export async function handleStats(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const stats = await client.stats_get()
    await say({ text: formatStats(stats), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: stats_get failed')
    await say({ text: formatError('Stats unavailable', err), thread_ts: ts })
  }
}

export async function handleRecent(ts: string, say: SayFn, client: CoreApiClient, limit: number): Promise<void> {
  try {
    const result = await client.captures_list({ limit })
    await say({ text: formatRecentCaptures(result.captures), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: captures_list failed')
    await say({ text: formatError('Could not retrieve recent captures', err), thread_ts: ts })
  }
}

export async function handleRetry(ts: string, say: SayFn, client: CoreApiClient, captureId: string): Promise<void> {
  try {
    await client.captures_retry(captureId)
    await say({ text: `Capture \`${captureId}\` queued for retry.`, thread_ts: ts })
  } catch (err) {
    logger.error({ err, captureId }, 'handleCommand: captures_retry failed')
    await say({ text: formatError('Retry failed', err), thread_ts: ts })
  }
}
