import { Worker, UnrecoverableError } from 'bullmq'
import { eq } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events, EmbeddingService, contentHash } from '@open-brain/shared'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { DocumentParserService } from '../services/document-parser.js'
import { chunkDocument } from '../ingestion/chunker.js'
import { DOCUMENT_PIPELINE_BACKOFF_DELAYS_MS } from '../queues/document-pipeline.js'
import type { DocumentPipelineJobData } from '../queues/document-pipeline.js'
import type { EmbedCaptureQueue } from '../queues/embed-capture.js'

/**
 * Custom BullMQ backoff strategy for document pipeline retry delays.
 * BullMQ calls this with attemptsMade (1-based after first failure).
 * Returns delay in milliseconds for the next attempt.
 *
 * Delays: attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 */
export function documentPipelineBackoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, DOCUMENT_PIPELINE_BACKOFF_DELAYS_MS.length - 1)
  return DOCUMENT_PIPELINE_BACKOFF_DELAYS_MS[idx]
}

/**
 * Document pipeline job handler.
 *
 * Processing flow:
 * 1. Fetch the parent document capture from DB (must have source='document'
 *    and source_metadata.file_path pointing to the uploaded file)
 * 2. Parse the document via DocumentParserService (PDF, DOCX, MD, TXT, HTML)
 * 3. Chunk: if document exceeds 8K tokens, split into overlapping 8K-token
 *    chunks with 512-token overlap
 * 4. For each chunk, create a sub-capture in the DB with:
 *    - source = 'document'
 *    - source_metadata.parent_id = parent capture UUID
 *    - source_metadata.chunk_index = 0-based chunk position
 *    - source_metadata.chunk_total = total chunks
 *    - source_metadata.original_filename from parent capture
 *    - source_metadata.char_start / char_end for traceability
 * 5. Enqueue each chunk capture for embedding (embed-capture queue)
 * 6. Update parent capture pipeline_status to 'chunked' (or 'complete'
 *    if the document fits in a single chunk)
 *
 * Failures:
 * - Capture not found → UnrecoverableError (no retry)
 * - File path missing → UnrecoverableError (no retry)
 * - File not accessible (ENOENT) → UnrecoverableError (no retry — file is gone)
 * - Parse failure → throw (triggers patient backoff retry)
 * - DB errors → throw (triggers patient backoff retry)
 *
 * @param data               Job data from document-pipeline queue
 * @param db                 Drizzle database instance
 * @param embeddingService   EmbeddingService for inline embedding (no-queue path)
 * @param embedCaptureQueue  If provided, chunks are queued for async embedding.
 *                           If omitted, chunks are embedded inline (tests/simple deploys).
 * @param parserService      DocumentParserService instance (injectable for testing)
 */
export async function processDocumentPipelineJob(
  data: DocumentPipelineJobData,
  db: Database,
  embeddingService: EmbeddingService,
  embedCaptureQueue?: EmbedCaptureQueue,
  parserService?: DocumentParserService,
): Promise<void> {
  const { captureId } = data
  const parser = parserService ?? new DocumentParserService()

  logger.info({ captureId }, '[document-pipeline] job received')

  const jobStart = Date.now()

  // ── 1. Fetch parent capture ────────────────────────────────────────────────
  const [parentCapture] = await db
    .select({
      id: captures.id,
      content: captures.content,
      capture_type: captures.capture_type,
      brain_view: captures.brain_view,
      source: captures.source,
      source_metadata: captures.source_metadata,
      pipeline_status: captures.pipeline_status,
      tags: captures.tags,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1)

  if (!parentCapture) {
    throw new UnrecoverableError(
      `[document-pipeline] capture ${captureId} not found — skipping`,
    )
  }

  // Skip if already in a terminal state (idempotency guard)
  if (
    parentCapture.pipeline_status === 'complete' ||
    parentCapture.pipeline_status === 'chunked' ||
    parentCapture.pipeline_status === 'failed'
  ) {
    logger.info(
      { captureId, pipeline_status: parentCapture.pipeline_status },
      '[document-pipeline] already terminal, skipping',
    )
    return
  }

  const meta = (parentCapture.source_metadata ?? {}) as Record<string, unknown>
  const filePath = meta.file_path as string | undefined
  const originalFilename = (meta.original_filename ?? meta.file_path ?? 'unknown') as string

  if (!filePath) {
    throw new UnrecoverableError(
      `[document-pipeline] capture ${captureId} has no file_path in source_metadata — skipping`,
    )
  }

  // Mark as processing
  await db
    .update(captures)
    .set({ pipeline_status: 'processing', updated_at: new Date() })
    .where(eq(captures.id, captureId))

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'document-parse',
    status: 'started',
  })

  logger.info({ captureId, filePath }, '[document-pipeline] parsing document')

  // ── 2. Parse document ──────────────────────────────────────────────────────
  const parseStart = Date.now()

  let documentText: string
  let pageCount: number | undefined

  try {
    const parsed = await parser.parseFile(filePath)
    documentText = parsed.text
    // DocumentParserService doesn't expose pageCount directly, but metadata.word_count is available
    pageCount = undefined // Not exposed by DocumentParserService
  } catch (err) {
    const parseDurationMs = Date.now() - parseStart
    const errMsg = err instanceof Error ? err.message : String(err)

    const isFileMissing =
      errMsg.toLowerCase().includes('no such file') ||
      errMsg.toLowerCase().includes('enoent')

    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'document-parse',
      status: 'failed',
      duration_ms: parseDurationMs,
      error: errMsg,
    })

    await db
      .update(captures)
      .set({ pipeline_error: errMsg, pipeline_status: 'failed', updated_at: new Date() })
      .where(eq(captures.id, captureId))

    logger.error({ captureId, filePath, err }, '[document-pipeline] document parse failed')

    if (isFileMissing) {
      throw new UnrecoverableError(
        `[document-pipeline] file not found at ${filePath} — skipping`,
      )
    }

    throw err // let BullMQ retry with patient backoff
  }

  const parseDurationMs = Date.now() - parseStart

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'document-parse',
    status: 'success',
    duration_ms: parseDurationMs,
    metadata: { chars: documentText.length },
  })

  logger.info(
    { captureId, chars: documentText.length, duration_ms: parseDurationMs },
    '[document-pipeline] document parsed',
  )

  // ── 3. Chunk document ──────────────────────────────────────────────────────
  const chunkStart = Date.now()
  const chunks = chunkDocument(documentText)
  const chunkDurationMs = Date.now() - chunkStart

  logger.info(
    { captureId, chunkCount: chunks.length, duration_ms: chunkDurationMs },
    '[document-pipeline] document chunked',
  )

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'document-chunk',
    status: 'success',
    duration_ms: chunkDurationMs,
    metadata: {
      chunk_count: chunks.length,
      estimated_tokens: chunks.map(c => c.estimatedTokens),
    },
  })

  // ── 4 & 5. Create sub-captures and enqueue for embedding ───────────────────
  const embedStart = Date.now()
  let embeddedCount = 0
  let skippedCount = 0

  for (const chunk of chunks) {
    const chunkContent = chunk.text.trim()
    if (!chunkContent) {
      skippedCount++
      continue
    }

    const chunkHash = contentHash(chunkContent)

    // Sub-capture source_metadata links back to parent
    const chunkSourceMetadata = {
      ...meta,
      parent_id: captureId,
      chunk_index: chunk.index,
      chunk_total: chunk.total,
      original_filename: originalFilename,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      estimated_tokens: chunk.estimatedTokens,
    }

    // Insert sub-capture — content_hash unique constraint prevents re-ingesting unchanged content
    let chunkCaptureId: string | undefined

    try {
      const [inserted] = await db
        .insert(captures)
        .values({
          content: chunkContent,
          content_hash: chunkHash,
          capture_type: parentCapture.capture_type,
          brain_view: parentCapture.brain_view,
          source: 'document',
          source_metadata: chunkSourceMetadata,
          tags: parentCapture.tags,
          pipeline_status: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: captures.id })

      if (!inserted) {
        // Duplicate chunk — skip embedding
        logger.debug(
          { captureId, chunkIndex: chunk.index, chunkHash },
          '[document-pipeline] chunk already exists (dedup), skipping',
        )
        skippedCount++
        continue
      }

      chunkCaptureId = inserted.id
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.warn(
        { captureId, chunkIndex: chunk.index, err: errMsg },
        '[document-pipeline] failed to insert chunk capture — skipping chunk',
      )
      skippedCount++
      continue
    }

    // ── Embed chunk ──────────────────────────────────────────────────────────
    if (embedCaptureQueue) {
      // Production path: enqueue for async embedding
      try {
        await embedCaptureQueue.add(
          'embed',
          { captureId: chunkCaptureId },
          { jobId: `embed:${chunkCaptureId}` },
        )
        embeddedCount++
        logger.debug(
          { captureId, chunkCaptureId, chunkIndex: chunk.index },
          '[document-pipeline] chunk enqueued for embedding',
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn(
          { captureId, chunkCaptureId, chunkIndex: chunk.index, err: errMsg },
          '[document-pipeline] failed to enqueue chunk — will be retried by daily sweep',
        )
        // Non-fatal: daily sweep picks up pending chunks
      }
    } else {
      // Inline embedding path (integration tests / simple deploys without Redis)
      try {
        const { sql } = await import('drizzle-orm')
        const embedding = await embeddingService.embed(chunkContent)

        await db.execute(
          sql`SELECT update_capture_embedding(${chunkCaptureId}::uuid, ${`[${embedding.join(',')}]`}::vector(768))`,
        )

        embeddedCount++
        logger.debug(
          { captureId, chunkCaptureId, chunkIndex: chunk.index },
          '[document-pipeline] chunk embedded inline',
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn(
          { captureId, chunkCaptureId, chunkIndex: chunk.index, err: errMsg },
          '[document-pipeline] inline embed failed — chunk remains pending',
        )
        // Non-fatal: chunk stays pending, daily sweep will retry
      }
    }
  }

  const embedDurationMs = Date.now() - embedStart

  // ── 6. Update parent capture pipeline_status ───────────────────────────────
  // 'complete' for single-chunk documents; 'chunked' for multi-chunk (chunks are separate captures)
  const finalStatus = chunks.length === 1 ? 'complete' : 'chunked'

  await db
    .update(captures)
    .set({
      pipeline_status: finalStatus,
      pipeline_completed_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(captures.id, captureId))

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'document-embed',
    status: 'success',
    duration_ms: embedDurationMs,
    metadata: {
      chunks_embedded: embeddedCount,
      chunks_skipped: skippedCount,
    },
  })

  const totalDurationMs = Date.now() - jobStart

  logger.info(
    {
      captureId,
      chunkCount: chunks.length,
      embeddedCount,
      skippedCount,
      finalStatus,
      duration_ms: totalDurationMs,
    },
    '[document-pipeline] job complete',
  )
}

/**
 * Creates and returns a BullMQ Worker for the 'document-pipeline' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createDocumentPipelineWorker(
  connection: ConnectionOptions,
  db: Database,
  configService: ConfigService,
  litellmBaseUrl: string,
  litellmApiKey: string,
  embedCaptureQueue?: EmbedCaptureQueue,
): Worker<DocumentPipelineJobData> {
  const embeddingService = new EmbeddingService(litellmBaseUrl, litellmApiKey, configService)
  const parserService = new DocumentParserService()

  const worker = new Worker<DocumentPipelineJobData>(
    'document-pipeline',
    async (job) => {
      await processDocumentPipelineJob(
        job.data,
        db,
        embeddingService,
        embedCaptureQueue,
        parserService,
      )
    },
    {
      connection,
      concurrency: 2, // document parsing is CPU-bound; limit concurrency
      settings: {
        backoffStrategy: documentPipelineBackoffStrategy,
      },
    },
  )

  worker.on('failed', (job, err) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    const attempts = job?.attemptsMade ?? 0
    logger.warn(
      { captureId, attempts, err: err.message },
      `[document-pipeline] job failed (attempt ${attempts})`,
    )
  })

  worker.on('completed', (job) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.info({ captureId }, '[document-pipeline] job completed successfully')
  })

  return worker
}
