import { Worker } from 'bullmq'
import { sql, inArray, and, lt } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { captures, captureAssociations } from '@open-brain/shared'
import type { AccessStatsJobData } from '../queues/access-stats.js'
import { logger } from '@open-brain/shared'

/** Maximum results to pair for co-access tracking (avoids N^2 explosion) */
const MAX_PAIR_RESULTS = 10

/**
 * Generates all unique pairs from an array, maintaining canonical UUID ordering
 * (smaller UUID first) for the capture_associations constraint.
 */
export function generateCanonicalPairs(ids: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      // Canonical ordering: smaller UUID first
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]]
      pairs.push([a, b])
    }
  }
  return pairs
}

/**
 * Upserts co-access associations for all pairs of capture IDs using a single
 * batch INSERT ... VALUES ... ON CONFLICT DO UPDATE statement.
 *
 * On conflict (pair already exists): increments co_access_count, updates
 * last_co_access, and recalculates weight using Hebbian decay formula:
 *   weight = co_access_count * exp(-0.005 * hours_since_last_co_access)
 *
 * 45 serial INSERTs (C(10,2)) replaced with 1 batch statement.
 */
export async function upsertCoAccessAssociations(
  pairs: Array<[string, string]>,
  accessedAt: string,
  db: Database,
): Promise<number> {
  if (pairs.length === 0) return 0

  const accessedAtDate = new Date(accessedAt)
  const valueFragments = pairs.map(([idA, idB]) =>
    sql`(${idA}::uuid, ${idB}::uuid, 1, 1.0, ${accessedAtDate})`
  )
  const valuesClause = sql.join(valueFragments, sql`, `)

  await db.execute(sql`
    INSERT INTO capture_associations
      (capture_id_a, capture_id_b, co_access_count, weight, last_co_access)
    VALUES ${valuesClause}
    ON CONFLICT (capture_id_a, capture_id_b) DO UPDATE SET
      co_access_count = capture_associations.co_access_count + 1,
      last_co_access  = EXCLUDED.last_co_access,
      weight          = (capture_associations.co_access_count + 1)
                        * exp(-0.005
                          * EXTRACT(EPOCH FROM (
                              EXCLUDED.last_co_access - capture_associations.last_co_access
                            )) / 3600.0)
  `)

  return pairs.length
}

/**
 * Processes an access-stats job: increments access_count and sets
 * last_accessed_at for every capture ID returned by a search, then
 * generates co-access associations (Hebbian learning) between the
 * top results.
 *
 * Uses a single batch UPDATE for access stats. Co-access pairs are
 * generated from at most the top 10 results to avoid N^2 explosion.
 * Job failure emits a WARN log only — the queue is configured for
 * 1 attempt, so there is no retry storm.
 */
export async function processAccessStatsJob(
  data: AccessStatsJobData,
  db: Database,
): Promise<void> {
  const { captureIds, accessedAt } = data

  if (captureIds.length === 0) {
    return
  }

  // 1. Update access_count and last_accessed_at (existing behavior)
  await db
    .update(captures)
    .set({
      access_count: sql`${captures.access_count} + 1`,
      last_accessed_at: new Date(accessedAt),
    })
    .where(inArray(captures.id, captureIds))

  // 2. Co-access tracking: pair the top N results and upsert associations
  if (captureIds.length >= 2) {
    const topIds = captureIds.slice(0, MAX_PAIR_RESULTS)
    const pairs = generateCanonicalPairs(topIds)
    try {
      const count = await upsertCoAccessAssociations(pairs, accessedAt, db)
      logger.debug({ pairCount: count }, 'co-access associations upserted')
    } catch (err) {
      // Co-access tracking is best-effort — don't fail the whole job
      logger.warn(
        { err: (err as Error).message, pairCount: pairs.length },
        'co-access association upsert failed (non-fatal)',
      )
    }
  }
}

/**
 * Creates and returns a BullMQ Worker for the 'access-stats' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createAccessStatsWorker(
  connection: ConnectionOptions,
  db: Database,
): Worker<AccessStatsJobData> {
  const worker = new Worker<AccessStatsJobData>(
    'access-stats',
    async (job) => {
      await processAccessStatsJob(job.data, db)
    },
    {
      connection,
      concurrency: 2, // P07: reduced from 5
    },
  )

  worker.on('failed', (job, err) => {
    const ids = job?.data?.captureIds ?? []
    logger.warn(
      { jobId: job?.id, captureCount: ids.length, err: err.message },
      `access-stats job ${job?.id ?? 'unknown'} failed for ${ids.length} capture(s)`,
    )
  })

  return worker
}

// ============================================================
// Association Pruning — removes stale, low-weight associations
// ============================================================

/** Default pruning thresholds */
const DEFAULT_PRUNE_WEIGHT_THRESHOLD = 0.1
const DEFAULT_PRUNE_STALE_DAYS = 90

export interface PruneAssociationsOptions {
  /** Delete associations with weight below this value (default: 0.1) */
  weightThreshold?: number
  /** Delete associations not co-accessed within this many days (default: 90) */
  staleDays?: number
}

export interface PruneAssociationsResult {
  /** Number of associations deleted */
  pruned: number
  /** Duration of the pruning operation in milliseconds */
  durationMs: number
}

/**
 * Prunes stale, low-weight capture associations.
 *
 * Deletes rows where BOTH conditions are met:
 *   - weight < weightThreshold (default 0.1)
 *   - last_co_access < NOW() - staleDays (default 90 days)
 *
 * This keeps active associations (recently co-accessed) and strong
 * associations (high weight even if old) intact. Only associations
 * that are both weak AND stale get removed.
 *
 * Designed to run periodically (e.g., daily-sweep or post access-stats).
 * Does not block normal access-stats processing — call separately.
 */
export async function pruneStaleAssociations(
  db: Database,
  options: PruneAssociationsOptions = {},
): Promise<PruneAssociationsResult> {
  const weightThreshold = options.weightThreshold ?? DEFAULT_PRUNE_WEIGHT_THRESHOLD
  const staleDays = options.staleDays ?? DEFAULT_PRUNE_STALE_DAYS
  const start = Date.now()

  const deleted = await db
    .delete(captureAssociations)
    .where(
      and(
        lt(captureAssociations.weight, weightThreshold),
        lt(captureAssociations.last_co_access, sql`NOW() - INTERVAL '${sql.raw(String(staleDays))} days'`),
      ),
    )
    .returning({ id: captureAssociations.id })

  const pruned = deleted.length
  const durationMs = Date.now() - start

  if (pruned > 0) {
    logger.info(
      { pruned, weightThreshold, staleDays, durationMs },
      `pruned ${pruned} stale association(s)`,
    )
  } else {
    logger.debug(
      { weightThreshold, staleDays, durationMs },
      'association pruning: nothing to prune',
    )
  }

  return { pruned, durationMs }
}

/**
 * Creates and returns a BullMQ Worker for the 'prune-associations' queue.
 * Runs pruneStaleAssociations() on each job trigger (typically weekly cron).
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createPruneAssociationsWorker(
  connection: ConnectionOptions,
  db: Database,
): Worker<{ triggeredAt: string }> {
  const worker = new Worker<{ triggeredAt: string }>(
    'prune-associations',
    async (_job) => {
      await pruneStaleAssociations(db)
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err: err.message }, 'prune-associations job failed')
  })

  return worker
}
