import { Worker, UnrecoverableError } from 'bullmq'
import { eq } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { PIPELINE_BACKOFF_DELAYS_MS } from '../queues/capture-pipeline.js'
import type { CapturePipelineJobData } from '../queues/capture-pipeline.js'
import type { EmbedCaptureQueue } from '../queues/embed-capture.js'

/**
 * Advance a capture's pipeline_status and record a pipeline_events row.
 *
 * @param db       Drizzle database instance
 * @param captureId UUID of the capture being processed
 * @param stage    Pipeline stage name (matches pipeline.yaml stage names)
 * @param status   Outcome of the stage
 * @param durationMs Wall-clock time for this stage
 * @param error    Error message if status === 'failed'
 * @param newPipelineStatus  New captures.pipeline_status value (if updating)
 */
async function recordStageEvent(
  db: Database,
  captureId: string,
  stage: string,
  status: 'started' | 'success' | 'failed',
  durationMs?: number,
  error?: string,
  newPipelineStatus?: string,
): Promise<void> {
  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage,
    status,
    duration_ms: durationMs,
    error,
  })

  if (newPipelineStatus) {
    await db
      .update(captures)
      .set({
        pipeline_status: newPipelineStatus,
        updated_at: new Date(),
      })
      .where(eq(captures.id, captureId))
  }
}

/**
 * Core pipeline job handler.
 *
 * Phase 6.1 scope: advances a capture from 'pending' → 'processing' →
 * 'extracted' (stub — real extraction implemented in later phases).
 *
 * The embed stage is intentionally omitted here; it is enqueued as a
 * separate BullMQ job (embed-capture queue) once extraction is wired up
 * in Phase 6.2. This worker establishes the structural pattern for all
 * subsequent stage workers.
 *
 * Failures:
 * - Capture not found → UnrecoverableError (no retry — data will never appear)
 * - DB errors during status update → throw (triggers BullMQ patient backoff)
 */
export async function processIngestionJob(
  data: CapturePipelineJobData,
  db: Database,
  embedCaptureQueue: EmbedCaptureQueue,
): Promise<void> {
  const { captureId } = data

  logger.info({ captureId }, '[ingestion] job received')

  // ── Fetch capture ──────────────────────────────────────────────────────────
  const [capture] = await db
    .select({
      id: captures.id,
      pipeline_status: captures.pipeline_status,
      pipeline_attempts: captures.pipeline_attempts,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1)

  if (!capture) {
    // Capture deleted or never existed — no point retrying
    throw new UnrecoverableError(
      `[ingestion] capture ${captureId} not found — skipping`,
    )
  }

  // Skip if already terminal — daily sweep may re-enqueue completed captures
  if (capture.pipeline_status === 'complete' || capture.pipeline_status === 'failed') {
    logger.info({ captureId, pipeline_status: capture.pipeline_status }, '[ingestion] already terminal, skipping')
    return
  }

  // ── Mark processing ────────────────────────────────────────────────────────
  const stageStart = Date.now()

  await db
    .update(captures)
    .set({
      pipeline_status: 'processing',
      pipeline_attempts: capture.pipeline_attempts + 1,
      pipeline_error: null,
      updated_at: new Date(),
    })
    .where(eq(captures.id, captureId))

  await recordStageEvent(db, captureId, 'received', 'started')

  logger.info({ captureId }, '[ingestion] marked processing')

  // ── Extract stage (stub) ───────────────────────────────────────────────────
  // Real text extraction (audio transcription, document parse) is implemented
  // in Phase 9 (voice-capture) and Phase 15 (document ingestor).
  // For now, immediately mark as 'extracted' so downstream stages can proceed.
  const extractStart = Date.now()

  try {
    await recordStageEvent(db, captureId, 'extract', 'started')

    // Stub: no-op. Future: call transcription or parser service here.

    const extractDurationMs = Date.now() - extractStart
    await recordStageEvent(db, captureId, 'extract', 'success', extractDurationMs, undefined, 'extracted')

    logger.info({ captureId, duration_ms: extractDurationMs }, '[ingestion] extract stage complete (stub)')

    // Enqueue embed-capture job — jobId = captureId for idempotency
    await embedCaptureQueue.add(
      'embed',
      { captureId },
      { jobId: `embed_${captureId}` },
    )
    logger.info({ captureId }, '[ingestion] embed-capture job enqueued')
  } catch (err) {
    const extractDurationMs = Date.now() - extractStart
    const errMsg = err instanceof Error ? err.message : String(err)

    await recordStageEvent(db, captureId, 'extract', 'failed', extractDurationMs, errMsg)
    await db
      .update(captures)
      .set({ pipeline_error: errMsg, updated_at: new Date() })
      .where(eq(captures.id, captureId))

    logger.error({ captureId, err }, '[ingestion] extract stage failed — retrying')
    throw err // let BullMQ retry with patient backoff
  }

  const totalDurationMs = Date.now() - stageStart
  logger.info({ captureId, duration_ms: totalDurationMs }, '[ingestion] job complete')
}

/**
 * Custom BullMQ backoff strategy for patient retry delays.
 * BullMQ calls this with attemptsMade (1-based after first failure).
 * Returns delay in milliseconds for the next attempt.
 *
 * Delays: attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 */
export function pipelineBackoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, PIPELINE_BACKOFF_DELAYS_MS.length - 1)
  return PIPELINE_BACKOFF_DELAYS_MS[idx]
}

/**
 * Creates and returns a BullMQ Worker for the 'capture-pipeline' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createIngestionWorker(
  connection: ConnectionOptions,
  db: Database,
  embedCaptureQueue: EmbedCaptureQueue,
): Worker<CapturePipelineJobData> {
  const worker = new Worker<CapturePipelineJobData>(
    'capture-pipeline',
    async (job) => {
      await processIngestionJob(job.data, db, embedCaptureQueue)
    },
    {
      connection,
      concurrency: 3,
      settings: {
        backoffStrategy: pipelineBackoffStrategy,
      },
    },
  )

  worker.on('failed', (job, err) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    const attempts = job?.attemptsMade ?? 0
    logger.warn(
      { captureId, attempts, err: err.message },
      `[ingestion] job failed (attempt ${attempts})`,
    )
  })

  worker.on('completed', (job) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.info({ captureId }, '[ingestion] job completed successfully')
  })

  return worker
}
