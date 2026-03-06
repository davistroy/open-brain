import { Worker } from 'bullmq'
import { eq, sql } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, triggers } from '@open-brain/shared'
import { PushoverService } from '../services/pushover.js'
import { logger } from '../lib/logger.js'
import type { CheckTriggersJobData } from '../queues/check-triggers.js'

const TRIGGER_CACHE_TTL_MS = 60_000 // 60-second cache for active triggers

/**
 * Cached active trigger entry including pre-parsed embedding.
 */
interface CachedTrigger {
  id: string
  name: string
  condition_text: string
  embedding: number[] | null
  threshold: number
  action_config: Record<string, unknown> | null
  last_triggered_at: Date | null
  trigger_count: number
}

interface TriggerCache {
  triggers: CachedTrigger[]
  refreshedAt: number
}

// Module-level cache — shared across all job invocations in this worker process
let triggerCache: TriggerCache | null = null

/**
 * Load active triggers from DB or return cached copy if still fresh.
 */
async function getActiveTriggers(db: Database): Promise<CachedTrigger[]> {
  const now = Date.now()

  if (triggerCache && now - triggerCache.refreshedAt < TRIGGER_CACHE_TTL_MS) {
    return triggerCache.triggers
  }

  const rows = await db
    .select({
      id: triggers.id,
      name: triggers.name,
      condition_text: triggers.condition_text,
      embedding: triggers.embedding,
      threshold: triggers.threshold,
      action_config: triggers.action_config,
      last_triggered_at: triggers.last_triggered_at,
      trigger_count: triggers.trigger_count,
    })
    .from(triggers)
    .where(eq(triggers.enabled, true))

  const cached: CachedTrigger[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    condition_text: row.condition_text,
    embedding: row.embedding as number[] | null,
    threshold: row.threshold,
    action_config: row.action_config as Record<string, unknown> | null,
    last_triggered_at: row.last_triggered_at,
    trigger_count: row.trigger_count,
  }))

  triggerCache = { triggers: cached, refreshedAt: now }
  logger.debug({ count: cached.length }, '[check-triggers] trigger cache refreshed')

  return cached
}

/**
 * Invalidate the trigger cache (call after any trigger mutation).
 */
export function invalidateTriggerCache(): void {
  triggerCache = null
}

/**
 * Compute cosine similarity between two normalized vectors.
 * Both vectors are assumed to be L2-normalized (unit length),
 * so cosine similarity = dot product.
 *
 * Returns a value in [-1, 1]. Returns 0 for empty or mismatched vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

/**
 * Check if a trigger is within its cooldown window.
 */
function isInCooldown(trigger: CachedTrigger): boolean {
  if (!trigger.last_triggered_at) return false

  const cooldownMinutes =
    typeof trigger.action_config?.cooldown_minutes === 'number'
      ? trigger.action_config.cooldown_minutes
      : 60

  const cooldownMs = cooldownMinutes * 60 * 1000
  const elapsed = Date.now() - new Date(trigger.last_triggered_at).getTime()
  return elapsed < cooldownMs
}

/**
 * Fire a trigger: send notification and update DB record.
 */
async function fireTrigger(
  trigger: CachedTrigger,
  captureId: string,
  captureContent: string,
  similarity: number,
  db: Database,
  pushoverService: PushoverService,
): Promise<void> {
  const deliveryChannel = trigger.action_config?.delivery_channel ?? 'pushover'

  logger.info(
    {
      triggerId: trigger.id,
      triggerName: trigger.name,
      captureId,
      similarity: similarity.toFixed(4),
      deliveryChannel,
    },
    '[check-triggers] trigger fired',
  )

  // Build notification message
  const preview =
    captureContent.length > 200 ? `${captureContent.slice(0, 200)}…` : captureContent

  const title = `Brain trigger: ${trigger.name}`
  const message = `Similarity ${(similarity * 100).toFixed(1)}%\n\n${preview}`

  // Send Pushover notification if channel includes pushover
  if (deliveryChannel === 'pushover' || deliveryChannel === 'both') {
    if (pushoverService.isConfigured) {
      try {
        await pushoverService.send({
          title,
          message,
          priority: 0, // normal priority for trigger notifications
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ triggerId: trigger.id, err: msg }, '[check-triggers] Pushover notification failed')
        // Non-fatal — trigger still counts as fired
      }
    } else {
      logger.debug({ triggerId: trigger.id }, '[check-triggers] Pushover not configured — skipping notification')
    }
  }

  // Update trigger last_triggered_at and fire count
  await db
    .update(triggers)
    .set({
      last_triggered_at: new Date(),
      trigger_count: sql`${triggers.trigger_count} + 1`,
      updated_at: new Date(),
    })
    .where(eq(triggers.id, trigger.id))

  // Invalidate cache so next job picks up the updated last_triggered_at
  invalidateTriggerCache()
}

/**
 * Core check-triggers job handler.
 *
 * Algorithm:
 * 1. Load active triggers from Redis-backed cache (60s TTL, refresh from DB if expired)
 * 2. Get capture embedding from DB
 * 3. For each active trigger not in cooldown: compute cosine similarity in-memory
 * 4. If similarity >= threshold: fire trigger (notification + DB update)
 * 5. All checks run in parallel (Promise.all)
 * 6. No match → no-op, complete successfully
 *
 * Performance: O(n) over trigger count (≤20), each <0.1ms for 768-dim dot product.
 * Target: <10ms for 20 triggers (in-memory comparison).
 */
export async function processCheckTriggersJob(
  data: CheckTriggersJobData,
  db: Database,
  pushoverService: PushoverService,
): Promise<void> {
  const { captureId } = data
  const start = Date.now()

  logger.debug({ captureId }, '[check-triggers] job received')

  // ── Load capture embedding ─────────────────────────────────────────────────
  const [capture] = await db
    .select({
      id: captures.id,
      content: captures.content,
      embedding: captures.embedding,
      pipeline_status: captures.pipeline_status,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1)

  if (!capture) {
    logger.warn({ captureId }, '[check-triggers] capture not found — skipping')
    return
  }

  if (!capture.embedding) {
    logger.warn({ captureId }, '[check-triggers] capture has no embedding — skipping')
    return
  }

  const captureEmbedding = capture.embedding as number[]

  // ── Load active triggers (cached) ─────────────────────────────────────────
  const activeTriggers = await getActiveTriggers(db)

  if (activeTriggers.length === 0) {
    logger.debug({ captureId }, '[check-triggers] no active triggers — done')
    return
  }

  // ── Check each trigger in parallel ────────────────────────────────────────
  await Promise.all(
    activeTriggers.map(async (trigger) => {
      if (!trigger.embedding) {
        logger.debug(
          { triggerId: trigger.id, triggerName: trigger.name },
          '[check-triggers] trigger has no embedding — skipping',
        )
        return
      }

      // Cooldown guard — skip if fired recently
      if (isInCooldown(trigger)) {
        logger.debug(
          { triggerId: trigger.id, triggerName: trigger.name },
          '[check-triggers] trigger in cooldown — skipping',
        )
        return
      }

      // Cosine similarity (dot product of normalized vectors)
      const similarity = cosineSimilarity(captureEmbedding, trigger.embedding)

      if (similarity >= trigger.threshold) {
        await fireTrigger(trigger, captureId, capture.content, similarity, db, pushoverService)
      }
    }),
  )

  const elapsed = Date.now() - start
  logger.debug(
    { captureId, triggerCount: activeTriggers.length, elapsed_ms: elapsed },
    '[check-triggers] check complete',
  )
}

/**
 * Creates and returns a BullMQ Worker for the 'check-triggers' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createCheckTriggersWorker(
  connection: ConnectionOptions,
  db: Database,
  pushoverAppToken?: string,
  pushoverUserKey?: string,
): Worker<CheckTriggersJobData> {
  const pushoverService = new PushoverService(pushoverAppToken, pushoverUserKey)

  const worker = new Worker<CheckTriggersJobData>(
    'check-triggers',
    async (job) => {
      await processCheckTriggersJob(job.data, db, pushoverService)
    },
    {
      connection,
      concurrency: 5, // multiple captures can be checked simultaneously
    },
  )

  worker.on('failed', (job, err) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.warn(
      { captureId, attempts: job?.attemptsMade, err: err.message },
      '[check-triggers] job failed',
    )
  })

  worker.on('completed', (job) => {
    const captureId = job?.data?.captureId ?? 'unknown'
    logger.debug({ captureId }, '[check-triggers] job completed')
  })

  return worker
}
