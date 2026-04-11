import { Worker, Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { IngestRootJobData } from '../flows/ingest-pipeline.js'
import { INGEST_ROOT_QUEUE_NAME } from '../flows/ingest-pipeline.js'
import { processLinkEntitiesStage } from '../pipeline/stages/link-entities.js'
import type { CheckTriggersJobData } from '../queues/check-triggers.js'

/**
 * Ingest-root job handler.
 *
 * This job runs AFTER the FlowProducer children (embed-capture and
 * extract-entities) have completed. It performs the post-pipeline
 * enrichment steps:
 *
 * 1. Link entities — resolves entity mentions from source_metadata
 *    and builds the co-occurrence graph. Non-blocking: failures are
 *    logged but do not affect pipeline status.
 *
 * 2. Check triggers — enqueues a check-triggers job to evaluate the
 *    new capture against active semantic triggers. Non-blocking.
 *
 * Pipeline status is NOT changed here — embed-capture already set it
 * to 'complete'. This handler is purely enrichment.
 */
export async function processIngestRootJob(
  data: IngestRootJobData,
  db: Database,
  checkTriggersQueue?: Queue<CheckTriggersJobData>,
): Promise<void> {
  const { captureId } = data
  const start = Date.now()

  logger.info({ captureId }, '[ingest-root] flow children completed, running post-pipeline enrichment')

  // ── Link entities (inline, non-blocking) ──────────────────────────────────
  try {
    await processLinkEntitiesStage(captureId, db)
    logger.debug({ captureId }, '[ingest-root] link-entities stage complete')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(
      { captureId, err: msg },
      '[ingest-root] link-entities stage failed — continuing (non-blocking enrichment)',
    )
    // Non-fatal: entity linking failure must not block pipeline completion
  }

  // ── Enqueue check-triggers (non-blocking) ─────────────────────────────────
  if (checkTriggersQueue) {
    try {
      await checkTriggersQueue.add(
        'check-triggers',
        { captureId },
        { jobId: `check-triggers_${captureId}_${Date.now()}` },
      )
      logger.debug({ captureId }, '[ingest-root] check-triggers job enqueued')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        { captureId, err: msg },
        '[ingest-root] failed to enqueue check-triggers — continuing',
      )
    }
  }

  const elapsed = Date.now() - start
  logger.info(
    { captureId, duration_ms: elapsed },
    '[ingest-root] post-pipeline enrichment complete',
  )
}

/**
 * Creates and returns a BullMQ Worker for the 'ingest-root' queue.
 *
 * This worker processes the root node of the FlowProducer DAG after
 * all children (embed-capture, extract-entities) have completed.
 *
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createIngestRootWorker(
  connection: ConnectionOptions,
  db: Database,
  checkTriggersQueue?: Queue<CheckTriggersJobData>,
): Worker<IngestRootJobData> {
  const worker = new Worker<IngestRootJobData>(
    INGEST_ROOT_QUEUE_NAME,
    async (job) => {
      await processIngestRootJob(job.data, db, checkTriggersQueue)
    },
    {
      connection,
      concurrency: 3,
    },
  )

  worker.on('failed', (job, err) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.warn(
      { captureId, attempts: job?.attemptsMade, err: err.message },
      '[ingest-root] job failed',
    )
  })

  worker.on('completed', (job) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.debug({ captureId }, '[ingest-root] job completed')
  })

  return worker
}
