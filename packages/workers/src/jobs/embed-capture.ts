import { Worker, UnrecoverableError, Queue, DelayedError } from 'bullmq'
import { sql } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events, EmbeddingService, EmbeddingUnavailableError } from '@open-brain/shared'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { EMBED_BACKOFF_DELAYS_MS } from '../queues/embed-capture.js'
import type { EmbedCaptureJobData } from '../queues/embed-capture.js'
import type { CheckTriggersJobData } from '../queues/check-triggers.js'
import type { ExtractEntitiesQueue } from '../queues/extract-entities.js'
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
  checkTriggersQueue?: Queue<CheckTriggersJobData>,
  extractEntitiesQueue?: ExtractEntitiesQueue,
  isFlowChild = false,
  spendTracker?: SpendTracker,
): Promise<void> {
  const { captureId } = data

  logger.info({ captureId }, '[embed] job received')

  // ── Spend-aware rate limiting ─────────────────────────────────────────────
  // Only non-Claude spend counts (Claude subscription = $0 marginal).
  // Throttle: add delay between jobs. Pause: re-queue with longer delay.
  if (spendTracker) {
    const spend = await spendTracker.check()

    if (spend.action === 'paused') {
      logger.warn(
        { captureId, monthlySpend: spend.monthlySpend },
        '[embed] non-Claude spend at hard limit — delaying job',
      )
      // Move job to delayed state — BullMQ will re-process after delay
      throw new DelayedError(`Embed paused: non-Claude spend $${spend.monthlySpend.toFixed(2)} at hard limit`)
    }

    if (spend.action === 'throttled') {
      logger.info(
        { captureId, monthlySpend: spend.monthlySpend },
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

  logger.info({ captureId, duration_ms: embedDurationMs }, '[embed] embedding complete, pipeline status → complete')

  // ── Enqueue downstream jobs (legacy path only) ─────────────────────────────
  // When running under FlowProducer, the flow DAG handles dependency ordering:
  // extract-entities runs as a sibling child, and check-triggers is enqueued by
  // the ingest-root parent job. Skip manual queue bridging to avoid duplicates.
  if (!isFlowChild) {
    // Legacy path: manual queue bridging
    if (checkTriggersQueue) {
      try {
        await checkTriggersQueue.add(
          'check-triggers',
          { captureId },
          { jobId: `check-triggers_${captureId}_${Date.now()}` },
        )
        logger.debug({ captureId }, '[embed] check-triggers job enqueued (legacy)')
      } catch (err) {
        // Non-fatal: trigger check failure must not block pipeline completion
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ captureId, err: msg }, '[embed] failed to enqueue check-triggers job — continuing')
      }
    }

    if (extractEntitiesQueue) {
      try {
        await extractEntitiesQueue.add(
          'extract-entities',
          { captureId },
          { jobId: `extract-entities_${captureId}` },
        )
        logger.debug({ captureId }, '[embed] extract-entities job enqueued (legacy)')
      } catch (err) {
        // Non-fatal: entity extraction failure must not block pipeline completion
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ captureId, err: msg }, '[embed] failed to enqueue extract-entities job — continuing')
      }
    }
  } else {
    logger.debug({ captureId }, '[embed] running under FlowProducer — skipping manual queue bridging')
  }
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
  checkTriggersQueue?: Queue<CheckTriggersJobData>,
  extractEntitiesQueue?: ExtractEntitiesQueue,
  spendTracker?: SpendTracker,
): Worker<EmbedCaptureJobData> {
  const embeddingService = new EmbeddingService(litellmBaseUrl, litellmApiKey, configService)

  const worker = new Worker<EmbedCaptureJobData>(
    'embed-capture',
    async (job) => {
      // Detect FlowProducer: job.parent exists when this job is a child in a flow DAG
      const isFlowChild = !!job.parent
      await processEmbedCaptureJob(job.data, db, embeddingService, checkTriggersQueue, extractEntitiesQueue, isFlowChild, spendTracker)
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
