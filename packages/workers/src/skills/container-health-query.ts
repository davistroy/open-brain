import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { container_health, logger } from '@open-brain/shared'
import type { ContainerCheckResult } from './container-health.js'

// ============================================================
// Container Health SQL Queries
// ============================================================

/**
 * Write health check results to the container_health table.
 * Each check is inserted individually; failures are logged but not thrown.
 */
export async function writeHealthCheckResults(
  db: Database,
  checks: ContainerCheckResult[],
): Promise<void> {
  for (const check of checks) {
    try {
      await db.insert(container_health).values({
        container_name: check.container_name,
        healthy: check.healthy,
        response_ms: check.response_ms,
        error: check.error ?? null,
        metadata: check.metadata ?? null,
      })
    } catch (err) {
      logger.warn({ err, container: check.container_name }, '[container-health] failed to write health check result')
    }
  }
}

/**
 * Count the most recent consecutive unhealthy checks for a container.
 * Scans the last 10 rows ordered by timestamp DESC.
 * Stops counting at the first healthy row.
 */
export async function getConsecutiveFailureCount(
  db: Database,
  containerName: string,
): Promise<number> {
  try {
    const rows = await db.execute<{ healthy: boolean }>(sql`
      SELECT healthy
      FROM container_health
      WHERE container_name = ${containerName}
      ORDER BY timestamp DESC
      LIMIT 10
    `)

    let count = 0
    for (const row of rows.rows as { healthy: boolean }[]) {
      if (!row.healthy) {
        count++
      } else {
        break
      }
    }
    return count
  } catch (err) {
    logger.warn({ err, containerName }, '[container-health] failed to count consecutive failures')
    return 0
  }
}
