import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { StorageMetrics } from './storage-audit.js'

// ============================================================
// Storage Audit SQL Queries
// ============================================================

/**
 * Gather Postgres storage metrics via SQL queries.
 *
 * Runs 4 queries: database size, table count, capture count, and 30-day growth rate.
 * Returns defaults on failure (any single query failure falls through to defaults).
 */
export async function getPostgresMetrics(
  db: Database,
): Promise<StorageMetrics['postgres']> {
  const defaults = { dbSizeBytes: 0, dbSizeHuman: 'unknown', tableCount: 0, captureCount: 0, captureGrowthRate: 0 }

  try {
    // DB size
    const sizeRows = await db.execute<{ size_bytes: string }>(sql`
      SELECT pg_database_size(current_database())::text AS size_bytes
    `)
    const dbSizeBytes = Number(sizeRows.rows[0]?.size_bytes ?? 0)

    // Table count
    const tableRows = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `)
    const tableCount = Number(tableRows.rows[0]?.count ?? 0)

    // Capture count
    const captureRows = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM captures
      WHERE deleted_at IS NULL
    `)
    const captureCount = Number(captureRows.rows[0]?.count ?? 0)

    // Growth rate: captures per day over last 30 days
    const growthRows = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM captures
      WHERE deleted_at IS NULL
        AND created_at >= NOW() - INTERVAL '30 days'
    `)
    const recentCaptures = Number(growthRows.rows[0]?.count ?? 0)
    const captureGrowthRate = Number((recentCaptures / 30).toFixed(1))

    return {
      dbSizeBytes,
      dbSizeHuman: formatBytes(dbSizeBytes),
      tableCount,
      captureCount,
      captureGrowthRate,
    }
  } catch (err) {
    logger.warn({ err }, '[storage-audit] failed to get Postgres metrics')
    return defaults
  }
}

// ============================================================
// Helpers
// ============================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}
