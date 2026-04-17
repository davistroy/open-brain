import { Worker, type ConnectionOptions, type Job } from 'bullmq'
import { eq, sql } from 'drizzle-orm'
import {
  dispatchToSidecar,
  file_uploads,
  HttpError,
  logger,
  type Database,
  type IngestProcessJobData,
  type SidecarProcessResponse,
  type UploadStatusEvent,
} from '@open-brain/shared'
import { INGEST_PROCESS_BACKOFF_DELAYS_MS } from '../queues/ingest-process.js'

// ============================================================
// CS3.5 — ingest-process BullMQ worker (Waves 2026-04-17)
//
// Consumes `ingest-process` jobs enqueued by:
//   - POST /api/v1/ingest/upload           (fresh upload)
//   - POST /api/v1/ingest/uploads/:id/process (re-run)
//   - POST /api/v1/ingest/process-now      (synthetic "scan inbox" job
//     with upload_id = 00000000-...-000000000000)
//
// Flow per job:
//   1. Load file_uploads row (skip for synthetic scan-inbox jobs).
//   2. UPDATE row to status='processing', emit pg_notify('upload_status', started).
//   3. POST /process on the sidecar for the source_type (via @open-brain/shared
//      `dispatchToSidecar`) with a configurable timeout (INGEST_TIMEOUT_MS,
//      default 300_000 ms).
//   4. On success: UPDATE row to status='parsed' with capture_ids, duration_ms,
//      processed_at; emit completed event.
//   5. On error: UPDATE row to status='failed' with error_message; emit
//      failed event; rethrow so BullMQ records the failure + schedules the
//      next patient-backoff retry.
//
// Retry policy: 5 attempts, patient backoff 30s → 2m → 10m → 30m → 2h
// (matches Open Brain canonical pipeline retry from CLAUDE.md).
//
// pg_notify channel: `upload_status` (consumed by the CS3.6 SSE hub,
// which fans the event out to browser subscribers as `upload:status`
// events using the `UploadStatusEventSchema` discriminated union).
// ============================================================

/** Channel name used by the CS3.6 SSE hub. Must match pg-notify.ts. */
const UPLOAD_STATUS_CHANNEL = 'upload_status'

/** All-zero UUID used by `/ingest/process-now` to indicate "scan inbox". */
const SCAN_INBOX_UPLOAD_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Custom BullMQ backoff strategy — mirrors the `extract-entities` worker
 * pattern and pulls delays from `INGEST_PROCESS_BACKOFF_DELAYS_MS`.
 */
export function ingestProcessBackoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, INGEST_PROCESS_BACKOFF_DELAYS_MS.length - 1)
  return INGEST_PROCESS_BACKOFF_DELAYS_MS[idx]
}

/**
 * Fire an `upload_status` pg_notify event. Runs in its own try/catch so
 * that a notify failure never aborts the primary DB update path. The
 * payload is validated upstream at the type level via `UploadStatusEvent`.
 */
async function emitUploadStatus(db: Database, event: UploadStatusEvent): Promise<void> {
  try {
    const payload = JSON.stringify(event)
    await db.execute(sql`SELECT pg_notify(${UPLOAD_STATUS_CHANNEL}, ${payload})`)
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, uploadId: event.upload_id, type: event.type },
      '[ingest-process] pg_notify upload_status failed (non-fatal)',
    )
  }
}

/**
 * Core job handler. Exposed for unit testing.
 */
export async function processIngestProcessJob(
  job: Job<IngestProcessJobData>,
  db: Database,
  opts: { secret: string; timeoutMs: number },
): Promise<SidecarProcessResponse> {
  const { upload_id, source_type, destination_path, parser_hint } = job.data
  const isScanInbox = upload_id === SCAN_INBOX_UPLOAD_ID
  const startedAt = Date.now()

  // ── Load the file_uploads row (unless this is a synthetic scan job) ──
  let row: typeof file_uploads.$inferSelect | undefined
  let filename = destination_path || `(scan-inbox:${source_type})`

  if (!isScanInbox) {
    const rows = await db
      .select()
      .from(file_uploads)
      .where(eq(file_uploads.id, upload_id))
      .limit(1)
    row = rows[0]
    if (!row) {
      // Row disappeared between enqueue and dispatch — unusual but not
      // retryable. Log and return an empty sidecar response so BullMQ
      // marks the job complete.
      logger.warn({ uploadId: upload_id, source_type }, '[ingest-process] upload row missing — skipping job')
      return { status: 'ok', captures_posted: [], errors: [`upload ${upload_id} not found`], duration_ms: 0 }
    }
    filename = row.filename
  }

  const startEvent: UploadStatusEvent = {
    type: 'started',
    upload_id,
    filename,
    source_type,
    size_bytes: row ? Number(row.size_bytes) : 0,
    at: new Date().toISOString(),
  }

  // ── UPDATE row → 'processing' + emit started event ───────────────────
  if (!isScanInbox) {
    await db
      .update(file_uploads)
      .set({ status: 'processing', error_message: null })
      .where(eq(file_uploads.id, upload_id))
  }
  await emitUploadStatus(db, startEvent)

  logger.info(
    { uploadId: upload_id, source_type, filename, attempt: job.attemptsMade + 1, parser_hint },
    '[ingest-process] dispatching to sidecar',
  )

  // ── POST /process to the sidecar ─────────────────────────────────────
  const secret = opts.secret || process.env.INGEST_TRIGGER_SECRET || ''
  if (!secret) {
    logger.warn({ uploadId: upload_id }, '[ingest-process] INGEST_TRIGGER_SECRET is empty — sidecar will reject with 401')
  }

  let response: SidecarProcessResponse
  try {
    response = await dispatchToSidecar({
      sourceType: source_type,
      fileId: upload_id,
      filePath: destination_path,
      secret,
      timeoutMs: opts.timeoutMs,
    })
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const errMsg =
      err instanceof HttpError
        ? `sidecar returned ${err.status}: ${err.message.slice(0, 500)}`
        : err instanceof Error
          ? err.message
          : String(err)

    if (!isScanInbox) {
      await db
        .update(file_uploads)
        .set({
          status: 'failed',
          error_message: errMsg.slice(0, 2000),
          processed_at: new Date(),
          duration_ms: durationMs,
        })
        .where(eq(file_uploads.id, upload_id))
    }

    const failedEvent: UploadStatusEvent = {
      type: 'failed',
      status: 'failed',
      upload_id,
      filename,
      source_type,
      error_message: errMsg.slice(0, 500),
      duration_ms: durationMs,
      at: new Date().toISOString(),
    }
    await emitUploadStatus(db, failedEvent)

    logger.error(
      { uploadId: upload_id, source_type, err: errMsg, attempt: job.attemptsMade + 1 },
      '[ingest-process] sidecar dispatch failed',
    )
    // Rethrow so BullMQ records the failure and schedules the next retry.
    throw err
  }

  // ── Success path ─────────────────────────────────────────────────────
  const durationMs = response.duration_ms || Date.now() - startedAt
  const captureIds = response.captures_posted ?? []
  const errors = response.errors ?? []
  const isSidecarError = response.status === 'error'

  if (!isScanInbox) {
    await db
      .update(file_uploads)
      .set({
        status: isSidecarError ? 'failed' : 'parsed',
        capture_ids: captureIds,
        error_message: isSidecarError ? errors.join('; ').slice(0, 2000) : null,
        processed_at: new Date(),
        duration_ms: durationMs,
      })
      .where(eq(file_uploads.id, upload_id))
  }

  if (isSidecarError) {
    const failedEvent: UploadStatusEvent = {
      type: 'failed',
      status: 'failed',
      upload_id,
      filename,
      source_type,
      error_message: errors.join('; ').slice(0, 500) || 'sidecar returned status=error',
      duration_ms: durationMs,
      at: new Date().toISOString(),
    }
    await emitUploadStatus(db, failedEvent)
    logger.warn(
      { uploadId: upload_id, source_type, errors, captureCount: captureIds.length },
      '[ingest-process] sidecar returned status=error',
    )
    // Sidecar-reported error is still a failure — rethrow so BullMQ retries.
    throw new Error(`sidecar ${source_type} returned status=error: ${errors.join('; ').slice(0, 200)}`)
  }

  const completedEvent: UploadStatusEvent = {
    type: 'completed',
    status: 'parsed',
    upload_id,
    filename,
    source_type,
    capture_ids: captureIds,
    duration_ms: durationMs,
    at: new Date().toISOString(),
  }
  await emitUploadStatus(db, completedEvent)

  logger.info(
    { uploadId: upload_id, source_type, captureCount: captureIds.length, durationMs },
    '[ingest-process] sidecar dispatch completed',
  )

  return response
}

export interface IngestProcessWorkerOptions {
  /** Override the shared secret sent to the sidecar. Defaults to env. */
  secret?: string
  /** Sidecar call timeout in ms. Defaults to env INGEST_TIMEOUT_MS or 300_000. */
  timeoutMs?: number
  /** BullMQ concurrency. Default 2 (sidecar serialises via /tmp/process.lock). */
  concurrency?: number
}

/**
 * Factory for the ingest-process BullMQ worker. The caller (workers/main.ts)
 * owns the returned Worker's lifecycle and must call `.close()` on shutdown.
 */
export function createIngestProcessWorker(
  connection: ConnectionOptions,
  db: Database,
  options: IngestProcessWorkerOptions = {},
): Worker<IngestProcessJobData> {
  const secret = options.secret ?? process.env.INGEST_TRIGGER_SECRET ?? ''
  const envTimeout = process.env.INGEST_TIMEOUT_MS
  const timeoutMs = options.timeoutMs ?? (envTimeout ? Number(envTimeout) : 300_000)
  const concurrency = options.concurrency ?? 2

  const worker = new Worker<IngestProcessJobData>(
    'ingest-process',
    async (job) => {
      await processIngestProcessJob(job, db, { secret, timeoutMs })
    },
    {
      connection,
      concurrency,
      settings: {
        backoffStrategy: ingestProcessBackoffStrategy,
      },
    },
  )

  worker.on('failed', (job, err) => {
    logger.warn(
      {
        jobId: job?.id,
        uploadId: job?.data?.upload_id,
        sourceType: job?.data?.source_type,
        attemptsMade: job?.attemptsMade,
        err: err.message,
      },
      `[ingest-process] job ${job?.id ?? 'unknown'} failed on attempt ${job?.attemptsMade ?? 0}`,
    )
  })

  worker.on('completed', (job) => {
    logger.debug(
      { jobId: job.id, uploadId: job.data.upload_id, sourceType: job.data.source_type },
      '[ingest-process] job completed',
    )
  })

  return worker
}
