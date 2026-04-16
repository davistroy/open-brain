import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { RecentFailure } from './pipeline-health.js'

// ============================================================
// SQL query helpers extracted from pipeline-health.ts
// These are the database queries used by PipelineHealthSkill.
// Exported separately for testability and reuse.
// ============================================================

/**
 * Query pipeline_events for 'failed' status entries within the lookback window.
 * Returns the most recent 50 failures (bounded result without unbounded scan).
 */
export async function queryRecentFailures(
  db: Database,
  lookbackMinutes: number,
): Promise<RecentFailure[]> {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000)

  try {
    const rows = await db.execute<{
      capture_id: string
      stage: string
      error: string | null
      created_at: string
    }>(sql`
      SELECT capture_id, stage, error, created_at
      FROM pipeline_events
      WHERE status = 'failed'
        AND created_at >= ${since.toISOString()}::timestamptz
      ORDER BY created_at DESC
      LIMIT 50
    `)
    return rows.rows as RecentFailure[]
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] failed to query pipeline_events — returning empty')
    return []
  }
}

/**
 * Check if captures are flowing. Returns true if no capture has been
 * created in the last `hoursThreshold` hours.
 * This detects silent failures where the system is "running" but not processing.
 */
export async function checkCaptureFlow(
  db: Database,
  hoursThreshold: number,
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000)
    const rows = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text as count
      FROM captures
      WHERE created_at >= ${since.toISOString()}::timestamptz
        AND deleted_at IS NULL
    `)
    const count = Number(rows.rows[0]?.count ?? 0)
    if (count === 0) {
      logger.warn({ hoursThreshold }, '[pipeline-health] no captures in recent window')
      return true
    }
    return false
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] failed to check capture flow — assuming OK')
    return false
  }
}

/**
 * Check if a capture-flow-stale alert was already sent within the last N hours.
 * Queries skills_log for pipeline-health entries where output_summary contains
 * both 'captureFlowStale:true' and 'alert:true'.
 */
export async function wasCaptureFlowAlertSentRecently(
  db: Database,
  hours: number,
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000)
    const rows = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text as count
      FROM skills_log
      WHERE skill_name = 'pipeline-health'
        AND created_at >= ${since.toISOString()}::timestamptz
        AND output_summary LIKE '%captureFlowStale:true%'
        AND output_summary LIKE '%alert:true%'
    `)
    return Number(rows.rows[0]?.count ?? 0) > 0
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] failed to check recent alert history — allowing alert')
    return false
  }
}
