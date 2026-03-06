import { Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { logger } from '../lib/logger.js'
import { PushoverService } from '../services/pushover.js'
import type { PushoverPriority } from '../services/pushover.js'

/**
 * Job payload for Pushover notifications.
 *
 * Priority semantics:
 * -1 — low (capture confirmed; no sound in quiet hours)
 *  0 — normal (brief ready, info alerts)
 *  1 — high (bet expiring, pipeline failure)
 *  2 — emergency (system health critical; repeats until acknowledged)
 */
export interface PushoverJobData {
  title: string
  message: string
  priority?: PushoverPriority
  url?: string
  url_title?: string
  /** Emergency (priority 2) only — repeat interval in seconds. Default: 60 */
  retry?: number
  /** Emergency (priority 2) only — total retry window in seconds. Default: 3600 */
  expire?: number
}

/**
 * Process a single Pushover notification job.
 *
 * Throws on delivery failure so BullMQ applies the configured retry backoff.
 * Three retries with 5-second fixed backoff handles transient Pushover API
 * outages without burning the retry budget on permanent failures.
 */
export async function processPushoverJob(
  data: PushoverJobData,
  pushoverService: PushoverService,
): Promise<void> {
  logger.info({ title: data.title, priority: data.priority ?? -1 }, '[pushover-job] processing')

  await pushoverService.send({
    title: data.title,
    message: data.message,
    priority: data.priority,
    url: data.url,
    url_title: data.url_title,
    retry: data.retry,
    expire: data.expire,
  })

  logger.info({ title: data.title }, '[pushover-job] delivered')
}

/**
 * Creates a BullMQ Worker for the 'pushover' queue.
 *
 * Queue options per TDD §12.2:
 * - priority: 7 (high — notifications are time-sensitive)
 * - timeout: 30s
 * - attempts: 3 with 5s fixed backoff
 * - concurrency: 2 (Pushover API has no strict per-second limit)
 *
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createPushoverWorker(
  connection: ConnectionOptions,
  appToken?: string,
  userKey?: string,
): Worker<PushoverJobData> {
  const pushoverService = new PushoverService(appToken, userKey)

  const worker = new Worker<PushoverJobData>(
    'pushover',
    async (job) => {
      await processPushoverJob(job.data, pushoverService)
    },
    {
      connection,
      concurrency: 2,
    },
  )

  worker.on('failed', (job, err) => {
    logger.warn(
      { jobId: job?.id, title: job?.data?.title, attempts: job?.attemptsMade, err: err.message },
      '[pushover-job] job failed',
    )
  })

  worker.on('completed', (job) => {
    logger.info({ jobId: job?.id, title: job?.data?.title }, '[pushover-job] job completed')
  })

  return worker
}
