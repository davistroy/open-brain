import { join, extname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { Queue } from 'bullmq'
import { eq, and, desc, inArray, sql } from 'drizzle-orm'
import {
  logger,
  ValidationError,
  AppError,
  UploadNotFoundError,
  file_uploads,
  captures,
  type Database,
  UploadFileMetadataSchema,
  ListUploadsQuerySchema,
  GetUploadParamsSchema,
  ProcessNowQuerySchema,
  IngestSourceTypeSchema,
  type IngestProcessJobData,
  type IngestSourceType,
  type UploadFileResponse,
  type ListUploadsResponse,
  type FileUploadRow,
  type ProcessNowResponse,
} from '@open-brain/shared'

// ============================================================
// CS3.4 — Ingest HTTP endpoints (Waves 2026-04-17)
//
// Surface:
//   POST /api/v1/ingest/upload            — multipart upload, max 100 MiB.
//   GET  /api/v1/ingest/uploads           — paginated list of file_uploads rows.
//   GET  /api/v1/ingest/uploads/:id       — single row detail.
//   POST /api/v1/ingest/uploads/:id/process
//                                         — re-enqueue an existing upload.
//   POST /api/v1/ingest/process-now       — manual inbox re-trigger (no upload).
//
// All endpoints validate with Zod schemas from @open-brain/shared (CS3.3).
// The multipart handler streams the body straight to disk so that 100 MiB
// uploads do not drive core-api RSS over the 1.5 GB ceiling — we never
// materialise the full file in memory.
//
// Rate limiting: the sidecar trigger_server and internal pipelines post
// callbacks as `X-Open-Brain-Caller: ingest`; that caller is bypassed via
// BYPASS_CALLERS in middleware/rate-limit.ts.
// ============================================================

/** Hard cap (100 MiB) — enforced while streaming the request body. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * Root directory that contains one subfolder per IngestSourceType. Matches the
 * bind-mount the sidecars will receive in CS3.13 deploy. Overridable for
 * tests and for local dev (`/tmp/open-brain-ingest`).
 */
function getIngestVolumeRoot(): string {
  return process.env.INGEST_VOLUME_ROOT ?? '/app/inbox-volumes'
}

/**
 * Light, local filename→route resolver. Kept intentionally narrow: it only
 * needs to pick a `source_type` folder and propagate a `parser_hint`.
 *
 * CS3.11 will introduce `services/ingest-router.ts` that reads
 * `config/ingest-routes.yaml` (the Python peer already exists in
 * `scripts/lib/ingest_router.py`, CS3.12). Once that service lands, this
 * helper is replaced by a call into it. Contract is intentionally the same:
 * `(filename) -> {source_type, parser_hint}`.
 */
function localRouteFile(filename: string): {
  source_type: IngestSourceType | null
  parser_hint: string | null
} {
  const lower = filename.toLowerCase()
  // Financial heuristics
  if (lower === 'activity.csv') return { source_type: 'financial', parser_hint: 'amex' }
  if (/^chase.*activity.*\.csv$/i.test(filename)) return { source_type: 'financial', parser_hint: 'chase' }
  if (/^acct_.*\.csv$/i.test(filename)) return { source_type: 'financial', parser_hint: 'truist' }
  if (/_transactions_.*\.csv$/i.test(filename)) return { source_type: 'financial', parser_hint: 'schwab_transactions' }
  if (/_balances_.*\.csv$/i.test(filename)) return { source_type: 'financial', parser_hint: 'schwab_balance' }
  if (/-positions-.*\.csv$/i.test(filename)) return { source_type: 'financial', parser_hint: 'schwab_position' }
  if (/^hsa.*\.csv$/i.test(filename)) return { source_type: 'financial', parser_hint: 'hsa' }
  if (/^download.*\.csv$/i.test(filename)) return { source_type: 'financial', parser_hint: 'paypal' }
  // Utility heuristics
  if (/gas.*\.pdf$/i.test(filename)) return { source_type: 'utility', parser_hint: 'gas_bill' }
  if (/power.*\.csv$/i.test(filename)) return { source_type: 'utility', parser_hint: 'power' }
  if (/electric.*\.csv$/i.test(filename)) return { source_type: 'utility', parser_hint: 'power' }
  return { source_type: null, parser_hint: null }
}

/** Safe-filename filter: strip path separators + control chars, keep extension. */
function sanitizeFilename(raw: string): string {
  const base = raw.replace(/[\r\n\0]+/g, '').trim()
  // Drop any directory traversal — keep just the trailing path component.
  const leaf = base.split(/[\\/]/).pop() ?? 'upload'
  // Replace anything that isn't [A-Za-z0-9._-] with '_'. Preserves extension.
  const scrubbed = leaf.replace(/[^A-Za-z0-9._-]/g, '_')
  // Collapse runs of underscores and clamp length.
  return scrubbed.replace(/_+/g, '_').slice(0, 200) || 'upload'
}

/** Stub dispatcher for the per-source sidecar HTTP trigger. CS3.5/CS3.11 replace this. */
export async function dispatchToSidecar(
  source: IngestSourceType,
  _uploadId: string,
  _filePath: string,
): Promise<void> {
  // Left as a TODO: the BullMQ `ingest-process` worker (CS3.5) is the real
  // caller of the sidecar. The route only enqueues the job; we keep this
  // helper exported so CS3.11's `services/ingest-router.ts` can pull it up
  // into the shared service layer once implemented.
  logger.debug({ source }, '[ingest] dispatchToSidecar is a stub — CS3.5 owns the worker')
}

/**
 * Stream a Web ReadableStream<Uint8Array> to a local file while counting
 * bytes. Aborts with ValidationError(413-style) if the limit is exceeded.
 */
async function streamBodyToFile(
  body: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  let bytesWritten = 0
  const sink = createWriteStream(destPath)
  const counter = new Writable({
    write(chunk: Buffer | Uint8Array, _enc, cb) {
      bytesWritten += chunk.byteLength
      if (bytesWritten > maxBytes) {
        cb(new ValidationError(`Upload exceeds maximum size of ${maxBytes} bytes`))
        return
      }
      sink.write(chunk, (err) => cb(err ?? null))
    },
    final(cb) {
      sink.end(() => cb())
    },
    destroy(err, cb) {
      sink.destroy(err ?? undefined)
      cb(err)
    },
  })
  await streamPipeline(Readable.fromWeb(body as never), counter)
  return bytesWritten
}

/**
 * GET-side row shaper. Joins capture rows on demand to produce the
 * `captures` snippet array the dashboard needs. A zero-capture row
 * returns `captures: []` without an extra query.
 */
async function shapeFileUploadRow(
  db: Database,
  row: typeof file_uploads.$inferSelect,
): Promise<FileUploadRow> {
  const ids = (row.capture_ids ?? []) as string[]
  let captureSummaries: { id: string; title_snippet: string }[] = []
  if (ids.length > 0) {
    const rows = await db
      .select({ id: captures.id, content: captures.content })
      .from(captures)
      .where(inArray(captures.id, ids))
    captureSummaries = rows.map((r) => ({
      id: r.id,
      title_snippet: (r.content ?? '').slice(0, 120),
    }))
  }

  return {
    id: row.id,
    filename: row.filename,
    size_bytes: Number(row.size_bytes),
    mime_type: row.mime_type ?? null,
    source_type: row.source_type as IngestSourceType,
    parser_hint: row.parser_hint ?? null,
    destination_path: row.destination_path,
    uploaded_at: row.uploaded_at.toISOString(),
    status: row.status,
    capture_ids: ids,
    captures: captureSummaries,
    error_message: row.error_message ?? null,
    processed_at: row.processed_at ? row.processed_at.toISOString() : null,
    duration_ms: row.duration_ms ?? null,
  }
}

/**
 * Register the `/api/v1/ingest/*` routes.
 *
 * `ingestProcessQueue` is the BullMQ queue for the `ingest-process` job
 * owned by CS3.5 in `packages/workers/src/jobs/ingest-process.ts`.
 * When the queue is undefined we still accept uploads (row is persisted
 * with `status='pending'`) but log a warning — mirrors how the document
 * upload route degrades when its pipeline queue is missing.
 */
export function registerIngestRoutes(
  app: Hono,
  db: Database,
  ingestProcessQueue?: Queue<IngestProcessJobData>,
): void {
  // ───────────────────────── POST /ingest/upload ─────────────────────────
  app.post('/api/v1/ingest/upload', async (c) => {
    const contentType = c.req.header('content-type') ?? ''

    // Two supported shapes:
    //   1) multipart/form-data — standard browser upload (parsed via formData).
    //   2) application/octet-stream — opaque byte stream (curl / iOS Shortcut).
    //      Metadata must be supplied via headers or the `?filename=` query.
    const rawBody = c.req.raw.body
    if (!rawBody) throw new ValidationError('Request body is required')

    const uploadId = randomUUID()

    // ── Resolve filename + optional metadata ─────────────────────────────
    let rawFilename: string | undefined
    let reportedMime: string | undefined
    let reportedSize: number | undefined
    let metadata: {
      source_type?: IngestSourceType
      parser_hint?: string
    } = {}

    let fileBytesSource: ReadableStream<Uint8Array> | null = null

    if (contentType.startsWith('multipart/form-data')) {
      // Hono buffers the multipart parse internally. For files up to 100 MiB
      // this is acceptable on an 8-core / 128 GB host; the streaming path
      // below is reserved for raw byte uploads that bypass FormData entirely.
      let formData: FormData
      try {
        formData = await c.req.formData()
      } catch {
        throw new ValidationError('Failed to parse multipart/form-data body')
      }
      const file = formData.get('file')
      if (!file || !(file instanceof File)) {
        throw new ValidationError('Missing required field: file')
      }
      rawFilename = file.name || 'upload'
      reportedMime = file.type || undefined
      reportedSize = Number(file.size) || undefined
      fileBytesSource = file.stream() as unknown as ReadableStream<Uint8Array>

      // Pull Zod-validated metadata fields from the form (all optional).
      const meta: Record<string, unknown> = {
        filename: rawFilename,
        size_bytes: reportedSize,
        mime_type: reportedMime,
        source_type: formData.get('source_type') ?? undefined,
        parser_hint: formData.get('parser_hint') ?? undefined,
      }
      const parsed = UploadFileMetadataSchema.safeParse(meta)
      if (!parsed.success) {
        throw new ValidationError(`Invalid metadata: ${parsed.error.message}`)
      }
      metadata = {
        source_type: parsed.data.source_type,
        parser_hint: parsed.data.parser_hint,
      }
    } else {
      // Raw body upload — read filename/source from headers or query string.
      rawFilename =
        c.req.header('x-filename') ??
        c.req.query('filename') ??
        'upload'
      reportedMime = contentType || undefined
      const sizeHeader = c.req.header('content-length')
      reportedSize = sizeHeader ? Number(sizeHeader) : undefined
      const querySourceRaw = c.req.query('source_type') ?? c.req.header('x-source-type')
      const queryHintRaw = c.req.query('parser_hint') ?? c.req.header('x-parser-hint')
      const meta: Record<string, unknown> = {
        filename: rawFilename,
        size_bytes: reportedSize,
        mime_type: reportedMime,
        source_type: querySourceRaw || undefined,
        parser_hint: queryHintRaw || undefined,
      }
      const parsed = UploadFileMetadataSchema.safeParse(meta)
      if (!parsed.success) {
        throw new ValidationError(`Invalid metadata: ${parsed.error.message}`)
      }
      metadata = {
        source_type: parsed.data.source_type,
        parser_hint: parsed.data.parser_hint,
      }
      fileBytesSource = rawBody as ReadableStream<Uint8Array>
    }

    const filename = sanitizeFilename(rawFilename!)

    // ── Resolve routing (source_type + parser_hint) ──────────────────────
    let sourceType: IngestSourceType | undefined = metadata.source_type
    let parserHint: string | null = metadata.parser_hint ?? null
    if (!sourceType) {
      const routed = localRouteFile(filename)
      if (!routed.source_type) {
        throw new ValidationError(
          `Unable to infer source_type for filename "${filename}". ` +
          'Pass source_type explicitly or use a recognised filename.',
        )
      }
      sourceType = routed.source_type
      parserHint = parserHint ?? routed.parser_hint
    }

    // Defensive guard — Zod enum should have caught anything off-schema.
    const sourceCheck = IngestSourceTypeSchema.safeParse(sourceType)
    if (!sourceCheck.success) {
      throw new ValidationError(`Invalid source_type: ${String(sourceType)}`)
    }

    // ── Stream body to disk under /ingest-root/<source>/<uuid>-<name> ────
    const root = getIngestVolumeRoot()
    const subdir = join(root, sourceType)
    await mkdir(subdir, { recursive: true })
    const destName = `${uploadId}-${filename}`
    const destPath = join(subdir, destName)

    let bytesWritten: number
    try {
      bytesWritten = await streamBodyToFile(fileBytesSource!, destPath, MAX_UPLOAD_BYTES)
    } catch (err) {
      if (err instanceof AppError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ uploadId, err: msg, destPath }, '[ingest] failed to write upload to disk')
      throw new AppError(`Failed to persist upload: ${msg}`, 500, 'INGEST_WRITE_FAILED')
    }

    // ── Insert file_uploads row ──────────────────────────────────────────
    const uploadedAt = new Date()
    const effectiveMime = reportedMime ?? 'application/octet-stream'
    const ext = extname(filename)
    const [inserted] = await db
      .insert(file_uploads)
      .values({
        id: uploadId,
        filename,
        size_bytes: bytesWritten,
        mime_type: effectiveMime,
        source_type: sourceType,
        parser_hint: parserHint,
        destination_path: destPath,
        uploaded_at: uploadedAt,
        status: 'pending',
      })
      .returning()

    if (!inserted) {
      throw new AppError('file_uploads insert returned no row', 500, 'INGEST_DB_FAILED')
    }

    // ── Enqueue ingest-process BullMQ job (CS3.5 consumes) ───────────────
    if (ingestProcessQueue) {
      try {
        await ingestProcessQueue.add(
          'ingest-process',
          {
            upload_id: inserted.id,
            source_type: sourceType,
            destination_path: destPath,
            parser_hint: parserHint,
          } satisfies IngestProcessJobData,
          { jobId: `ingest_${inserted.id}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
        )
        logger.info(
          { uploadId: inserted.id, sourceType, filename, bytesWritten, ext },
          '[ingest] upload accepted + ingest-process job enqueued',
        )
      } catch (err) {
        // Same policy as documents: persisted row + file stay on disk; daily
        // sweep / manual `/process` endpoint can re-drive the pipeline.
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(
          { uploadId: inserted.id, err: msg },
          '[ingest] enqueue ingest-process job failed — upload persisted, pipeline pending',
        )
      }
    } else {
      logger.warn(
        { uploadId: inserted.id },
        '[ingest] ingest-process queue not configured — upload persisted without job',
      )
    }

    const response: UploadFileResponse = {
      upload_id: inserted.id,
      status: inserted.status,
      filename: inserted.filename,
      size_bytes: Number(inserted.size_bytes),
      source_type: inserted.source_type as IngestSourceType,
      parser_hint: inserted.parser_hint ?? null,
      destination_path: inserted.destination_path,
      uploaded_at: inserted.uploaded_at.toISOString(),
    }
    return c.json(response, 201)
  })

  // ───────────────────────── GET /ingest/uploads ─────────────────────────
  app.get('/api/v1/ingest/uploads', async (c) => {
    const queryParsed = ListUploadsQuerySchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
      status: c.req.query('status'),
      source_type: c.req.query('source_type'),
    })
    if (!queryParsed.success) {
      throw new ValidationError(`Invalid query: ${queryParsed.error.message}`)
    }
    const { limit, offset, status, source_type } = queryParsed.data

    const conditions = [] as ReturnType<typeof eq>[]
    if (status) conditions.push(eq(file_uploads.status, status))
    if (source_type) conditions.push(eq(file_uploads.source_type, source_type))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [rows, totalRow] = await Promise.all([
      db
        .select()
        .from(file_uploads)
        .where(where)
        .orderBy(desc(file_uploads.uploaded_at))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(file_uploads)
        .where(where),
    ])

    const uploads = await Promise.all(rows.map((r) => shapeFileUploadRow(db, r)))
    const total = totalRow[0]?.count ?? 0

    const response: ListUploadsResponse = {
      uploads,
      total: Number(total),
      limit,
      offset,
    }
    return c.json(response)
  })

  // ───────────────────── GET /ingest/uploads/:id ─────────────────────────
  app.get('/api/v1/ingest/uploads/:id', async (c) => {
    const paramsParsed = GetUploadParamsSchema.safeParse({ id: c.req.param('id') })
    if (!paramsParsed.success) {
      throw new ValidationError(`Invalid id: ${paramsParsed.error.message}`)
    }
    const rows = await db
      .select()
      .from(file_uploads)
      .where(eq(file_uploads.id, paramsParsed.data.id))
      .limit(1)
    if (rows.length === 0) {
      throw new UploadNotFoundError(`Upload not found: ${paramsParsed.data.id}`)
    }
    const shaped = await shapeFileUploadRow(db, rows[0]!)
    return c.json(shaped)
  })

  // ──────────────── POST /ingest/uploads/:id/process ─────────────────────
  // Re-enqueues a specific upload row for reprocessing. Row status flips
  // back to 'pending' so the worker picks it up cleanly.
  app.post('/api/v1/ingest/uploads/:id/process', async (c) => {
    const paramsParsed = GetUploadParamsSchema.safeParse({ id: c.req.param('id') })
    if (!paramsParsed.success) {
      throw new ValidationError(`Invalid id: ${paramsParsed.error.message}`)
    }

    const rows = await db
      .select()
      .from(file_uploads)
      .where(eq(file_uploads.id, paramsParsed.data.id))
      .limit(1)
    if (rows.length === 0) {
      throw new UploadNotFoundError(`Upload not found: ${paramsParsed.data.id}`)
    }
    const row = rows[0]!

    await db
      .update(file_uploads)
      .set({ status: 'pending', error_message: null, processed_at: null, duration_ms: null })
      .where(eq(file_uploads.id, row.id))

    if (!ingestProcessQueue) {
      logger.warn({ id: row.id }, '[ingest] process-now requested but queue not configured')
      const resp: ProcessNowResponse = {
        source: row.source_type as IngestSourceType,
        enqueued: false,
        message: 'ingest-process queue not configured',
      }
      return c.json(resp, 503)
    }

    try {
      await ingestProcessQueue.add(
        'ingest-process',
        {
          upload_id: row.id,
          source_type: row.source_type as IngestSourceType,
          destination_path: row.destination_path,
          parser_hint: row.parser_hint ?? null,
        } satisfies IngestProcessJobData,
        {
          // Override the same jobId so BullMQ de-dupes a re-run against any
          // stuck instance from the original upload.
          jobId: `ingest_${row.id}_rerun_${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ id: row.id, err: msg }, '[ingest] reprocess enqueue failed')
      throw new AppError(`Failed to enqueue reprocess job: ${msg}`, 500, 'INGEST_ENQUEUE_FAILED')
    }

    logger.info({ id: row.id }, '[ingest] upload re-enqueued for processing')
    const resp: ProcessNowResponse = {
      source: row.source_type as IngestSourceType,
      enqueued: true,
    }
    return c.json(resp)
  })

  // ─────────────────── POST /ingest/process-now ──────────────────────────
  // Manual "process inbox now" trigger — no upload required. Fans out a
  // synthetic job per requested source so the worker can hit the sidecar.
  // The worker treats rows with no `destination_path` as "scan inbox".
  app.post('/api/v1/ingest/process-now', async (c) => {
    const queryParsed = ProcessNowQuerySchema.safeParse({
      source: c.req.query('source'),
    })
    if (!queryParsed.success) {
      throw new ValidationError(`Invalid query: ${queryParsed.error.message}`)
    }

    // `source` is optional at the schema level — default to 'financial' for
    // the dashboard "process inbox now" button. The worker accepts both.
    const source: IngestSourceType = queryParsed.data.source ?? 'financial'

    if (!ingestProcessQueue) {
      const resp: ProcessNowResponse = {
        source,
        enqueued: false,
        message: 'ingest-process queue not configured',
      }
      return c.json(resp, 503)
    }

    // Manual triggers do not correspond to a file_uploads row — we pass an
    // all-zero UUID so the worker recognises the "scan inbox" mode. CS3.5
    // owner: treat upload_id '00000000-...' as a special case, hit the
    // sidecar with the default inbox path.
    try {
      await ingestProcessQueue.add(
        'ingest-process',
        {
          upload_id: '00000000-0000-0000-0000-000000000000',
          source_type: source,
          destination_path: '',
          parser_hint: null,
        } satisfies IngestProcessJobData,
        {
          jobId: `ingest_manual_${source}_${Date.now()}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ source, err: msg }, '[ingest] process-now enqueue failed')
      throw new AppError(`Failed to enqueue process-now: ${msg}`, 500, 'INGEST_ENQUEUE_FAILED')
    }

    logger.info({ source }, '[ingest] process-now triggered')
    const resp: ProcessNowResponse = { source, enqueued: true }
    return c.json(resp)
  })
}
