import { Worker, UnrecoverableError, DelayedError } from 'bullmq'
import { sql } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events, EmbeddingService, EmbeddingUnavailableError } from '@open-brain/shared'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { EMBED_BACKOFF_DELAYS_MS } from '../queues/embed-capture.js'
import type { EmbedCaptureJobData } from '../queues/embed-capture.js'
import type { SpendTracker } from '../lib/spend-tracker.js'

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
 * EmbeddingService (LiteLLM → spark-qwen3-embedding-4b, Matryoshka 2560d→768d), and atomically writes the embedding
 * + sets pipeline_status = 'embedded' via update_capture_embedding().
 *
 * Failures:
 * - Capture not found → UnrecoverableError (no retry — data will never appear)
 * - EmbeddingUnavailableError → throw (triggers BullMQ patient backoff)
 *   NO fallback — queue and retry per architecture decision.
 * - DB errors → throw (triggers BullMQ patient backoff)
 */
/** Throttle delay when spend is between soft and hard limits */
const THROTTLE_DELAY_MS = 30_000 // 30 seconds between jobs
/** Pause delay when spend is at or above hard limit */
const PAUSE_DELAY_MS = 600_000 // 10 minutes before re-checking

export async function processEmbedCaptureJob(
  data: EmbedCaptureJobData,
  db: Database,
  embeddingService: EmbeddingService,
  spendTracker?: SpendTracker,
): Promise<void> {
  const { captureId, traceId } = data
  const log = traceId ? logger.child({ captureId, traceId }) : logger.child({ captureId })

  log.info('[embed] job received')

  // ── Spend-aware rate limiting ─────────────────────────────────────────────
  // Only non-Claude spend counts (Claude subscription = $0 marginal).
  // Throttle: add delay between jobs. Pause: re-queue with longer delay.
  if (spendTracker) {
    const spend = await spendTracker.check()

    if (spend.action === 'paused') {
      log.warn(
        { monthlySpend: spend.monthlySpend },
        '[embed] non-Claude spend at hard limit — delaying job',
      )
      // Move job to delayed state — BullMQ will re-process after delay
      throw new DelayedError(`Embed paused: non-Claude spend $${spend.monthlySpend.toFixed(2)} at hard limit`)
    }

    if (spend.action === 'throttled') {
      log.info(
        { monthlySpend: spend.monthlySpend },
        '[embed] non-Claude spend above soft limit — throttling',
      )
      // Brief delay to slow processing rate — not a full pause
      await new Promise(resolve => setTimeout(resolve, THROTTLE_DELAY_MS))
    }
  }

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
    log.info(
      { pipeline_status: capture.pipeline_status },
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
    metadata: traceId ? { trace_id: traceId } : undefined,
  })

  log.info('[embed] calling EmbeddingService')

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
      metadata: traceId ? { trace_id: traceId } : undefined,
    })

    await db
      .update(captures)
      .set({ pipeline_error: errMsg, updated_at: new Date() })
      .where(eq(captures.id, captureId))

    // EmbeddingUnavailableError (and any other error) must propagate so
    // BullMQ retries with patient backoff. No fallback.
    if (err instanceof EmbeddingUnavailableError) {
      log.warn({ err: errMsg }, '[embed] embedding unavailable — will retry with backoff')
    } else {
      log.error({ err }, '[embed] unexpected error during embed')
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
      metadata: traceId ? { trace_id: traceId } : undefined,
    })

    log.error({ err }, '[embed] DB write failed after embedding')
    throw err
  }

  const embedDurationMs = Date.now() - embedStart

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'embed',
    status: 'success',
    duration_ms: embedDurationMs,
    metadata: traceId ? { trace_id: traceId } : undefined,
  })

  // Advance pipeline to 'complete' — extract-entities is non-blocking enrichment
  // and must not gate pipeline completion per architecture decision.
  await db
    .update(captures)
    .set({
      pipeline_status: 'complete',
      pipeline_completed_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(captures.id, captureId))

  log.info({ duration_ms: embedDurationMs }, '[embed] embedding complete, pipeline status → complete')
  // FlowProducer DAG handles downstream jobs (extract-entities as sibling child,
  // check-triggers enqueued by ingest-root parent). No manual queue bridging needed.
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
  spendTracker?: SpendTracker,
): Worker<EmbedCaptureJobData> {
  const embeddingService = new EmbeddingService(litellmBaseUrl, litellmApiKey, configService)

  const worker = new Worker<EmbedCaptureJobData>(
    'embed-capture',
    async (job) => {
      await processEmbedCaptureJob(job.data, db, embeddingService, spendTracker)
    },
    {
      connection,
      concurrency: 2, // embedding calls can run in parallel; LiteLLM handles batching
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
