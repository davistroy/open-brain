import { Worker } from 'bullmq'
import { sql } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

// ============================================================
// Retention policy
//
// Each entry declares a table, the timestamp column to compare
// against, and how many days of data to retain.  Rows older
// than `days` are deleted and the count is logged to
// retention_audit.
//
// CRITICAL: admin_audit is intentionally ABSENT.  It is the
// permanent audit trail for /admin/reset-data and must never
// be pruned.  The invariant is asserted by the test suite.
// ============================================================

export interface RetentionPolicyEntry {
  /** DB table name — must be a static string from this config, never user input. */
  table: string
  /** Timestamp column to filter on. */
  column: string
  /** Rows older than this many days are deleted. */
  days: number
}

export const RETENTION_POLICY: readonly RetentionPolicyEntry[] = [
  { table: 'pipeline_events', column: 'created_at', days: 90  },
  { table: 'ai_audit_log',    column: 'created_at', days: 180 },
  { table: 'activity_feed',   column: 'timestamp',  days: 30  },
  { table: 'mcp_activity',    column: 'created_at', days: 30  },
  { table: 'skills_log',      column: 'created_at', days: 60  },
] as const

// admin_audit deliberately excluded — see module header.

// ============================================================
// Job data
// ============================================================

export interface DataRetentionPruneJobData {
  triggeredAt: string // ISO 8601 — informational
}

// ============================================================
// Per-entry result
// ============================================================

export interface RetentionPruneResult {
  table: string
  deletedCount: number
  durationMs: number
}

/** A single table's DELETE (or audit INSERT) failing during a prune run. */
export interface RetentionPruneFailure {
  table: string
  error: string
  durationMs: number
}

// ============================================================
// Core prune logic
// ============================================================

/**
 * Runs one DELETE pass per policy entry and records each result in
 * retention_audit.
 *
 * Table and column names are injected as `sql.raw()` — they come from the
 * static RETENTION_POLICY config, never from user input, so raw embedding
 * is safe.  The interval days value is also embedded raw (a validated
 * integer from the same config), not parameterised, because PostgreSQL does
 * not accept `$1 days` inside an INTERVAL expression.
 *
 * Per-table fault isolation (Phase 1 / CS-A): each entry's DELETE + audit
 * INSERT runs in its own try/catch. A failure on one table (e.g. an FK
 * constraint blocking a DELETE) is logged and the loop CONTINUES to the
 * remaining tables — one table's failure must never silently skip the
 * others. `retention_audit` has no status/error column (it's a DB-internal
 * housekeeping table, migration 0035, written only by this job), so a
 * failed table gets no audit row, only a structured error log. Failures are
 * accumulated and, once the loop completes, surfaced by throwing an
 * aggregate error — this rejects the BullMQ job (see
 * `createDataRetentionPruneWorker`'s `'failed'` handler) so pipeline-health's
 * failed-job alerting still fires. Failures are NEVER silently swallowed.
 *
 * @param db       Drizzle database instance
 * @param policy   Retention policy to execute (defaults to RETENTION_POLICY)
 */
export async function pruneRetentionData(
  db: Database,
  policy: readonly RetentionPolicyEntry[] = RETENTION_POLICY,
): Promise<RetentionPruneResult[]> {
  const results: RetentionPruneResult[] = []
  const failures: RetentionPruneFailure[] = []

  for (const entry of policy) {
    const entryStart = Date.now()

    try {
      // 1. DELETE aged rows and count them via a CTE.
      //    table/column/days are static config values injected as sql.raw()
      //    so they appear inline in the rendered SQL (no parameterisation
      //    needed; table identifiers are not accepted as $1 by PG anyway).
      const deleteResult = await db.execute(sql`
        WITH deleted AS (
          DELETE FROM ${sql.raw(entry.table)}
          WHERE ${sql.raw(entry.column)} < NOW() - INTERVAL '${sql.raw(String(entry.days))} days'
          RETURNING 1
        )
        SELECT COUNT(*)::bigint AS deleted_count FROM deleted
      `)

      const deletedCount = Number(deleteResult.rows[0]?.deleted_count ?? 0)
      const cutoff = new Date(Date.now() - entry.days * 24 * 60 * 60 * 1000)

      // 2. Record the prune run in retention_audit.
      //    table_name and deletedCount are parameterised ($1/$2) — safe values
      //    from our own config, but we follow the parameterisation convention
      //    for data (vs. identifiers above).
      await db.execute(sql`
        INSERT INTO retention_audit (table_name, deleted_count, cutoff, ran_at)
        VALUES (${entry.table}, ${deletedCount}, ${cutoff}, NOW())
      `)

      const durationMs = Date.now() - entryStart

      logger.info(
        { table: entry.table, column: entry.column, days: entry.days, deletedCount, durationMs },
        '[data-retention-prune] table pruned',
      )

      results.push({ table: entry.table, deletedCount, durationMs })
    } catch (err) {
      const durationMs = Date.now() - entryStart
      const message = err instanceof Error ? err.message : String(err)

      logger.error(
        { table: entry.table, column: entry.column, days: entry.days, durationMs, err: message },
        '[data-retention-prune] table prune FAILED — continuing to remaining tables',
      )

      failures.push({ table: entry.table, error: message, durationMs })
    }
  }

  if (failures.length > 0) {
    const summary = failures.map(f => `${f.table}: ${f.error}`).join('; ')
    throw new Error(
      `[data-retention-prune] ${failures.length}/${policy.length} table(s) failed to prune: ${summary}`,
    )
  }

  return results
}

// ============================================================
// Worker factory
// ============================================================

/**
 * Creates a BullMQ Worker for the 'data-retention-prune' queue.
 *
 * Concurrency = 1 (singleton) — this job performs destructive bulk DELETEs
 * across five tables; concurrent runs would cause redundant work and
 * obscure per-table delete counts in retention_audit.
 *
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createDataRetentionPruneWorker(
  connection: ConnectionOptions,
  db: Database,
): Worker<DataRetentionPruneJobData> {
  const worker = new Worker<DataRetentionPruneJobData>(
    'data-retention-prune',
    async (job) => {
      logger.info(
        { triggeredAt: job.data.triggeredAt },
        '[data-retention-prune] starting retention prune run',
      )

      const results = await pruneRetentionData(db)

      const totalDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0)
      logger.info(
        { totalDeleted, tables: results.map(r => ({ table: r.table, deleted: r.deletedCount })) },
        '[data-retention-prune] retention prune complete',
      )
    },
    {
      connection,
      concurrency: 1, // singleton — destructive bulk DELETE across 5 tables
    },
  )

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message },
      '[data-retention-prune] job failed',
    )
  })

  worker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, '[data-retention-prune] job completed')
  })

  return worker
}
