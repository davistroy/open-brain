import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import { formatPipelineStatus, formatError } from '../../lib/formatters.js'
import { logger } from '../../lib/logger.js'

export async function handlePipelineStatus(ts: string, say: SayFn, client: CoreApiClient): Promise<void> {
  try {
    const health = await client.pipeline_health()
    await say({ text: formatPipelineStatus(health), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleCommand: pipeline_health failed')
    await say({ text: formatError('Pipeline status unavailable', err), thread_ts: ts })
  }
}
