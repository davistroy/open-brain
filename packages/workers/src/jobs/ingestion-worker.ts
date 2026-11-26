import { Worker, UnrecoverableError } from 'bullmq'
import type { FlowProducer } from 'bullmq'
import { eq } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database, PipelineEventStage, PipelineEventStatus } from '@open-brain/shared'
import { captures, pipeline_events } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { PIPELINE_BACKOFF_DELAYS_MS } from '../queues/capture-pipeline.js'
import type { CapturePipelineJobData } from '../queues/capture-pipeline.js'
import { buildIngestFlow, INGEST_FLOW_QUEUES_OPTIONS } from '../flows/ingest-pipeline.js'
import { getFlowState, redriveCapture } from '../flows/redrive.js'
import type { FlowState, RedriveOptions, RedriveResult } from '../flows/redrive.js'
import type { IngestDedup } from '../lib/ingest-dedup.js'

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
  stage: PipelineEventStage,
  status: PipelineEventStatus,
  durationMs?: number,
  error?: string,
  newPipelineStatus?: string,
  traceId?: string,
): Promise<void> {
  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage,
    status,
    duration_ms: durationMs,
    error,
    metadata: traceId ? { trace_id: traceId } : undefined,
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
 * Re-drive hooks injected into processIngestionJob (item 9.1). Bound to a
 * connection + FlowProducer by createIngestionWorker; tests pass stubs.
 */
export interface IngestRedrive {
  getFlowState: (captureId: string) => Promise<FlowState>
  redriveCapture: (captureId: string, opts: RedriveOptions) => Promise<RedriveResult>
}

/** Build the real re-drive hooks for a connection + FlowProducer. */
export function createIngestRedrive(connection: ConnectionOptions, flowProducer: FlowProducer): IngestRedrive {
  return {
    getFlowState: (captureId) => getFlowState(connection, captureId),
    redriveCapture: (captureId, opts) => redriveCapture({ connection, flowProducer }, captureId, opts),
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
 * Re-drive (item 9.1): flow jobs carry FIXED ids, so a retained failed
 * `embed_<id>` / `ingest-root_<id>` blocks a plain re-add. Before any status
 * update the handler asks `redrive.getFlowState`:
 *   - 'in-flight' → warn and return; the capture is not touched.
 *   - `stage: 'all'` also re-drives a 'complete' capture (see isTerminal).
 *   - 'none', status ≠ 'extracted', no `stage: 'all'` → first run: add the
 *     full flow as before.
 *   - anything else → once the status reaches 'extracted', call
 *     `redrive.redriveCapture` (embed-only, or full with `stage: 'all'`).
 *
 * Failures:
 * - Capture not found → UnrecoverableError (no retry — data will never appear)
 * - DB errors during status update → throw (triggers BullMQ patient backoff)
 */
export async function processIngestionJob(
  data: CapturePipelineJobData,
  db: Database,
  flowProducer: FlowProducer,
  ingestDedup?: IngestDedup,
  redrive?: IngestRedrive,
): Promise<void> {
  const { captureId, forceRetry } = data

  logger.info({ captureId }, '[ingestion] job received')

  // ── Fetch capture ──────────────────────────────────────────────────────────
  const [capture] = await db
    .select({
      id: captures.id,
      content_hash: captures.content_hash,
      pipeline_status: captures.pipeline_status,
      pipeline_attempts: captures.pipeline_attempts,
      source_metadata: captures.source_metadata,
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

  // Skip if already terminal — daily sweep may re-enqueue completed captures.
  // forceRetry (from POST /api/v1/captures/:id/retry) bypasses the 'failed'
  // guard only. `stage: 'all'` (retry route ?stage=all) bypasses the
  // 'complete' guard only: embed succeeded but an enrichment child failed
  // (removeDependencyOnFailure), so the capture is 'complete' and the full
  // re-drive is exactly what was asked for. 'deleted' is always terminal.
  const isTerminal =
    (capture.pipeline_status === 'complete' && data.stage !== 'all') ||
    capture.pipeline_status === 'deleted' ||
    (capture.pipeline_status === 'failed' && !forceRetry)

  if (isTerminal) {
    logger.info({ captureId, pipeline_status: capture.pipeline_status, forceRetry }, '[ingestion] already terminal, skipping')
    return
  }

  // ── Extract trace ID from source_metadata ─────────────────────────────────
  const sourceMeta = capture.source_metadata as Record<string, unknown> | null
  const traceId = (sourceMeta?.trace_id as string | undefined) ?? data.traceId
  const log = traceId ? logger.child({ captureId, traceId }) : logger.child({ captureId })

  // ── Retained flow state (item 9.1) — before any status update ─────────────
  const flowState: FlowState = redrive ? await redrive.getFlowState(captureId) : 'none'
  if (flowState === 'in-flight') {
    log.warn('[ingestion] flow already in flight — leaving capture untouched')
    return
  }
  const useRedrive =
    flowState !== 'none' || capture.pipeline_status === 'extracted' || data.stage === 'all'

  // ── Content hash dedup ────────────────────────────────────────────────────
  // Check Redis for recent duplicates (5-min TTL). This catches iOS Shortcut
  // retries and rapid double-submits before they enter the pipeline.
  // The DB unique index on content_hash is the permanent dedup — this is a
  // fast-path optimization to avoid wasted pipeline work.
  // forceRetry (retry route) skips it: the key is <hash>:<captureId> with a
  // 5-min TTL, so a retry inside that window would be dropped as a duplicate.
  if (ingestDedup && capture.content_hash && !forceRetry) {
    const isDup = await ingestDedup.isDuplicate(capture.content_hash, captureId)
    if (isDup) {
      logger.info(
        { captureId, content_hash: capture.content_hash },
        '[ingestion] duplicate content hash in dedup window — skipping pipeline',
      )
      return
    }
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

  await recordStageEvent(db, captureId, 'received', 'started', undefined, undefined, undefined, traceId)

  log.info('[ingestion] marked processing')

  // ── Extract stage (stub) ───────────────────────────────────────────────────
  // Real text extraction (audio transcription, document parse) is implemented
  // in Phase 9 (voice-capture) and Phase 15 (document ingestor).
  // For now, immediately mark as 'extracted' so downstream stages can proceed.
  const extractStart = Date.now()

  try {
    await recordStageEvent(db, captureId, 'extract', 'started', undefined, undefined, undefined, traceId)

    // Stub: no-op. Future: call transcription or parser service here.

    const extractDurationMs = Date.now() - extractStart
    await recordStageEvent(db, captureId, 'extract', 'success', extractDurationMs, undefined, 'extracted', traceId)

    log.info({ duration_ms: extractDurationMs }, '[ingestion] extract stage complete (stub)')

    // Enqueue downstream pipeline via FlowProducer DAG
    const includeWikiIngest = !!process.env.WIKI_REPO_URL
    if (useRedrive && redrive) {
      const result = await redrive.redriveCapture(captureId, {
        stage: data.stage === 'all' ? 'all' : 'embed',
        includeWikiIngest,
        traceId,
      })
      log.info({ flowState, result }, '[ingestion] re-drive of retained flow')
    } else {
      const flow = buildIngestFlow(captureId, { includeWikiIngest, traceId })
      await flowProducer.add(flow, { queuesOptions: INGEST_FLOW_QUEUES_OPTIONS })
      log.info({ includeWikiIngest }, '[ingestion] FlowProducer DAG enqueued (embed + extract + ingest-root)')
    }
  } catch (err) {
    const extractDurationMs = Date.now() - extractStart
    const errMsg = err instanceof Error ? err.message : String(err)

    await recordStageEvent(db, captureId, 'extract', 'failed', extractDurationMs, errMsg, undefined, traceId)
    await db
      .update(captures)
      .set({ pipeline_error: errMsg, updated_at: new Date() })
      .where(eq(captures.id, captureId))

    log.error({ err }, '[ingestion] extract stage failed — retrying')
    throw err // let BullMQ retry with patient backoff
  }

  const totalDurationMs = Date.now() - stageStart
  log.info({ duration_ms: totalDurationMs }, '[ingestion] job complete')
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
  flowProducer: FlowProducer,
  ingestDedup?: IngestDedup,
): Worker<CapturePipelineJobData> {
  const redrive = createIngestRedrive(connection, flowProducer)
  const worker = new Worker<CapturePipelineJobData>(
    'capture-pipeline',
    async (job) => {
      await processIngestionJob(job.data, db, flowProducer, ingestDedup, redrive)
    },
    {
      connection,
      concurrency: 2, // P07: reduced from 3
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
