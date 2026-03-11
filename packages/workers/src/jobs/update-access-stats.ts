import { Worker } from 'bullmq'
import { sql, inArray } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures } from '@open-brain/shared'
import type { AccessStatsJobData } from '../queues/access-stats.js'
import { logger } from '../lib/logger.js'

/**
 * Processes an access-stats job: increments access_count and sets
 * last_accessed_at for every capture ID returned by a search.
 *
 * Uses a single batch UPDATE for efficiency. Job failure emits a WARN
 * log only — the queue is configured for 1 attempt, so there is no retry storm.
 */
export async function processAccessStatsJob(
  data: AccessStatsJobData,
  db: Database,
): Promise<void> {
  const { captureIds, accessedAt } = data

  if (captureIds.length === 0) {
    return
  }

  await db
    .update(captures)
    .set({
      access_count: sql`${captures.access_count} + 1`,
      last_accessed_at: new Date(accessedAt),
    })
    .where(inArray(captures.id, captureIds))
}

/**
 * Creates and returns a BullMQ Worker for the 'access-stats' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createAccessStatsWorker(
  connection: ConnectionOptions,
  db: Database,
): Worker<AccessStatsJobData> {
  const worker = new Worker<AccessStatsJobData>(
    'access-stats',
    async (job) => {
      await processAccessStatsJob(job.data, db)
    },
    {
      connection,
      concurrency: 5,
    },
  )

  worker.on('failed', (job, err) => {
    const ids = job?.data?.captureIds ?? []
    logger.warn(
      { jobId: job?.id, captureCount: ids.length, err: err.message },
      `access-stats job ${job?.id ?? 'unknown'} failed for ${ids.length} capture(s)`,
    )
  })

  return worker
}
