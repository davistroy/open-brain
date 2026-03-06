import { Worker, Queue } from 'bullmq'
import { sql } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import type { CapturePipelineJobData } from '../queues/capture-pipeline.js'

export interface DailySweepJobData {
  triggeredAt: string // ISO 8601 — informational
}

/**
 * Daily sweep job handler.
 *
 * Finds captures stuck in 'pending' or 'processing' status for more than
 * 2 hours (outlasted the initial 5-attempt / 2h-total retry window) and
 * re-enqueues them as fresh capture-pipeline jobs.
 *
 * Re-enqueue uses jobId = captureId so BullMQ deduplicates — if a capture
 * is already queued, adding it again with the same jobId is a no-op.
 */
export async function processDailySweepJob(
  data: DailySweepJobData,
  db: Database,
  capturePipelineQueue: Queue<CapturePipelineJobData>,
): Promise<void> {
  logger.info({ triggeredAt: data.triggeredAt }, '[daily-sweep] starting sweep')

  // Query captures stuck for > 2 hours — past the full patient backoff window
  const stuck = await db.execute<{ id: string }>(
    sql.raw(`
      SELECT id
      FROM captures
      WHERE pipeline_status IN ('pending', 'processing')
        AND updated_at < NOW() - INTERVAL '2 hours'
    `),
  )

  const stuckCaptures = stuck.rows as Array<{ id: string }>

  if (stuckCaptures.length === 0) {
    logger.info('[daily-sweep] no stuck captures found')
    return
  }

  logger.info({ count: stuckCaptures.length }, '[daily-sweep] re-enqueuing stuck captures')

  let requeued = 0
  for (const { id } of stuckCaptures) {
    try {
      // jobId = captureId for idempotency — BullMQ ignores duplicate job IDs
      await capturePipelineQueue.add(
        'ingest',
        { captureId: id },
        { jobId: id },
      )
      requeued++
    } catch (err) {
      logger.warn({ captureId: id, err }, '[daily-sweep] failed to re-enqueue capture')
    }
  }

  logger.info({ requeued, total: stuckCaptures.length }, '[daily-sweep] sweep complete')
}

/**
 * Creates a BullMQ Worker for the 'daily-sweep' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createDailySweepWorker(
  connection: ConnectionOptions,
  db: Database,
  capturePipelineQueue: Queue<CapturePipelineJobData>,
): Worker<DailySweepJobData> {
  const worker = new Worker<DailySweepJobData>(
    'daily-sweep',
    async (job) => {
      await processDailySweepJob(job.data, db, capturePipelineQueue)
    },
    {
      connection,
      concurrency: 1, // sweep is a singleton operation
    },
  )

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message },
      '[daily-sweep] job failed',
    )
  })

  worker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, '[daily-sweep] job completed')
  })

  return worker
}
