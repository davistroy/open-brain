import { Worker, UnrecoverableError } from 'bullmq'
import { sql } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events, EmbeddingService, EmbeddingUnavailableError } from '@open-brain/shared'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { EMBED_BACKOFF_DELAYS_MS } from '../queues/embed-capture.js'
import type { EmbedCaptureJobData } from '../queues/embed-capture.js'

/**
 * Custom BullMQ backoff strategy for patient embed retry delays.
 * BullMQ calls this with attemptsMade (1-based after first failure).
 * Returns delay in milliseconds for the next attempt.
 *
 * Delays: attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 */
export function embedBackoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, EMBED_BACKOFF_DELAYS_MS.length - 1)
  return EMBED_BACKOFF_DELAYS_MS[idx]
}

/**
 * Core embed job handler.
 *
 * Reads capture content from DB, generates a 768-dim embedding via
 * EmbeddingService (LiteLLM → Jetson), and atomically writes the embedding
 * + sets pipeline_status = 'embedded' via update_capture_embedding().
 *
 * Failures:
 * - Capture not found → UnrecoverableError (no retry — data will never appear)
 * - EmbeddingUnavailableError → throw (triggers BullMQ patient backoff)
 *   NO fallback — queue and retry per architecture decision.
 * - DB errors → throw (triggers BullMQ patient backoff)
 */
export async function processEmbedCaptureJob(
  data: EmbedCaptureJobData,
  db: Database,
  embeddingService: EmbeddingService,
): Promise<void> {
  const { captureId } = data

  logger.info({ captureId }, '[embed] job received')

  // ── Fetch capture content ──────────────────────────────────────────────────
  const [capture] = await db
    .select({
      id: captures.id,
      content: captures.content,
      pipeline_status: captures.pipeline_status,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1)

  if (!capture) {
    // Capture deleted or never existed — no point retrying
    throw new UnrecoverableError(
      `[embed] capture ${captureId} not found — skipping`,
    )
  }

  // Skip if already embedded or terminal — idempotency guard
  if (
    capture.pipeline_status === 'embedded' ||
    capture.pipeline_status === 'complete' ||
    capture.pipeline_status === 'failed'
  ) {
    logger.info(
      { captureId, pipeline_status: capture.pipeline_status },
      '[embed] already at or past embedded status, skipping',
    )
    return
  }

  // ── Embed stage ────────────────────────────────────────────────────────────
  const embedStart = Date.now()

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'embed',
    status: 'started',
  })

  logger.info({ captureId }, '[embed] calling EmbeddingService')

  let embedding: number[]
  try {
    embedding = await embeddingService.embed(capture.content)
  } catch (err) {
    const embedDurationMs = Date.now() - embedStart
    const errMsg = err instanceof Error ? err.message : String(err)

    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'embed',
      status: 'failed',
      duration_ms: embedDurationMs,
      error: errMsg,
    })

    await db
      .update(captures)
      .set({ pipeline_error: errMsg, updated_at: new Date() })
      .where(eq(captures.id, captureId))

    // EmbeddingUnavailableError (and any other error) must propagate so
    // BullMQ retries with patient backoff. No fallback.
    if (err instanceof EmbeddingUnavailableError) {
      logger.warn({ captureId, err: errMsg }, '[embed] embedding unavailable — will retry with backoff')
    } else {
      logger.error({ captureId, err }, '[embed] unexpected error during embed')
    }
    throw err
  }

  // ── Atomically write embedding + set pipeline_status = 'embedded' ──────────
  try {
    await db.execute(
      sql`SELECT update_capture_embedding(${captureId}::uuid, ${`[${embedding.join(',')}]`}::vector(768))`,
    )
  } catch (err) {
    const embedDurationMs = Date.now() - embedStart
    const errMsg = err instanceof Error ? err.message : String(err)

    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'embed',
      status: 'failed',
      duration_ms: embedDurationMs,
      error: errMsg,
    })

    logger.error({ captureId, err }, '[embed] DB write failed after embedding')
    throw err
  }

  const embedDurationMs = Date.now() - embedStart

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'embed',
    status: 'success',
    duration_ms: embedDurationMs,
  })

  logger.info({ captureId, duration_ms: embedDurationMs }, '[embed] embedding complete')
}

/**
 * Creates and returns a BullMQ Worker for the 'embed-capture' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createEmbedCaptureWorker(
  connection: ConnectionOptions,
  db: Database,
  configService: ConfigService,
  litellmBaseUrl: string,
  litellmApiKey: string,
): Worker<EmbedCaptureJobData> {
  const embeddingService = new EmbeddingService(litellmBaseUrl, litellmApiKey, configService)

  const worker = new Worker<EmbedCaptureJobData>(
    'embed-capture',
    async (job) => {
      await processEmbedCaptureJob(job.data, db, embeddingService)
    },
    {
      connection,
      concurrency: 2, // embedding calls can run in parallel; Jetson handles batching
      settings: {
        backoffStrategy: embedBackoffStrategy,
      },
    },
  )

  worker.on('failed', (job, err) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    const attempts = job?.attemptsMade ?? 0
    logger.warn(
      { captureId, attempts, err: err.message },
      `[embed] job failed (attempt ${attempts})`,
    )
  })

  worker.on('completed', (job) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.info({ captureId }, '[embed] job completed successfully')
  })

  return worker
}
