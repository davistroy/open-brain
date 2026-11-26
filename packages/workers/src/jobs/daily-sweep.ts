import { Worker, Queue } from 'bullmq'
import { and, inArray, isNull, lt } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { CapturePipelineJobData } from '../queues/capture-pipeline.js'
import { SWEEPABLE_STATUSES } from '../lib/sweepable-statuses.js'

/**
 * Per-day sweep job ID: `sweep_<captureId>_<yyyymmdd>` (UTC date of the run).
 * BullMQ drops an add whose job ID is still retained, so a fixed ID (the old
 * jobId = captureId) made every sweep after the first a silent no-op. A
 * per-day ID lets each night's sweep through while still deduplicating a
 * double-fired sweep within the same day.
 */
export function sweepJobId(captureId: string, date: Date): string {
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, '')
  return `sweep_${captureId}_${yyyymmdd}`
}

export interface DailySweepJobData {
  triggeredAt: string // ISO 8601 — informational
}

/**
 * Daily sweep job handler.
 *
 * Finds captures stuck in a sweepable status (pending / processing /
 * extracted — see SWEEPABLE_STATUSES) for more than 1 hour (outlasted the
 * initial 5-attempt / 2h-total retry window) and re-enqueues them as fresh
 * capture-pipeline jobs.
 *
 * Re-enqueue uses jobId = sweepJobId(captureId, today) — one job per capture
 * per UTC day. Soft-deleted captures are never swept. The ingestion worker
 * re-drives the embed (flows/redrive.ts) for a capture whose flow was retained.
 */
export async function processDailySweepJob(
  data: DailySweepJobData,
  db: Database,
  capturePipelineQueue: Queue<CapturePipelineJobData>,
): Promise<void> {
  logger.info({ triggeredAt: data.triggeredAt }, '[daily-sweep] starting sweep')

  // Query captures stuck for > 1 hour — catches transient failures that
  // outlasted the initial retry window (LiteLLM blip, Redis restart, etc.)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

  const stuckCaptures = await db
    .select({ id: captures.id })
    .from(captures)
    .where(
      and(
        inArray(captures.pipeline_status, [...SWEEPABLE_STATUSES]),
        lt(captures.created_at, oneHourAgo),
        isNull(captures.deleted_at),
      ),
    )

  if (stuckCaptures.length === 0) {
    logger.info('[daily-sweep] no stuck captures found')
    return
  }

  logger.info({ count: stuckCaptures.length }, '[daily-sweep] re-enqueuing stuck captures')

  const now = new Date()
  let requeued = 0
  for (const { id } of stuckCaptures) {
    try {
      // per-day jobId: a retained job from an earlier day must not drop this add
      await capturePipelineQueue.add(
        'ingest',
        { captureId: id },
        { jobId: sweepJobId(id, now) },
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
