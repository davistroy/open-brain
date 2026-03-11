import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

// ============================================================
// Types
// ============================================================

/**
 * Structured output from the drift monitor AI call.
 */
export interface DriftMonitorOutput {
  summary: string
  drift_items: DriftItem[]
  overall_health: 'healthy' | 'minor_drift' | 'significant_drift' | 'critical_drift'
}

export interface DriftItem {
  item_type: 'bet' | 'commitment' | 'entity'
  item_name: string
  severity: 'high' | 'medium' | 'low'
  days_silent: number
  reason: string
  suggested_action: string
}

export interface DriftMonitorResult {
  output: DriftMonitorOutput
  durationMs: number
  /** UUID of the capture created to store the drift report back into the brain */
  savedCaptureId: string | null
  /** Whether a Pushover notification was sent (only if severity >= medium items exist) */
  notificationSent: boolean
}

export interface DriftMonitorOptions {
  /** How many days back to check for bet activity. Default: 14. */
  betActivityDays?: number
  /** How many days of governance sessions to scan for commitments. Default: 30. */
  commitmentDays?: number
  /** Rolling window for entity frequency comparison (in days). Default: 7. */
  entityWindowDays?: number
  /** Override the AI model alias. Default: 'synthesis'. */
  modelAlias?: string
}

// ============================================================
// Pending bet with activity data
// ============================================================

export interface PendingBet {
  id: string
  statement: string
  confidence: number
  domain: string | null
  resolution_date: string | null
  created_at: string
}

export interface BetWithActivity extends PendingBet {
  recent_capture_count: number
  days_since_last_mention: number | null
}

// ============================================================
// Entity frequency data
// ============================================================

export interface EntityFrequency {
  entity_id: string
  entity_name: string
  entity_type: string
  current_count: number
  previous_count: number
  /** Percentage change: negative means decline */
  change_pct: number
}

// ============================================================
// Governance commitment data
// ============================================================

export interface GovernanceCommitment {
  session_id: string
  session_date: string
  summary: string | null
  /** Last assistant message from the session — often contains action items */
  closing_message: string | null
}

// ============================================================
// Constants
// ============================================================

export const DEFAULT_BET_ACTIVITY_DAYS = 14
export const DEFAULT_COMMITMENT_DAYS = 30
export const DEFAULT_ENTITY_WINDOW_DAYS = 7

// ============================================================
// Query functions
// ============================================================

/**
 * Fetch all pending bets (resolution = 'pending' or null).
 */
export async function queryPendingBets(db: Database): Promise<PendingBet[]> {
  try {
    const rows = await db.execute<{
      id: string
      statement: string
      confidence: number
      domain: string | null
      resolution_date: string | null
      created_at: string
    }>(sql`
      SELECT id, statement, confidence, domain, resolution_date, created_at
      FROM bets
      WHERE resolution = 'pending' OR resolution IS NULL
      ORDER BY created_at DESC
    `)
    return rows.rows as PendingBet[]
  } catch (err) {
    logger.warn({ err }, '[drift-monitor] failed to query pending bets')
    return []
  }
}

/**
 * For each pending bet, count recent captures that mention the bet's statement
 * (via full-text search) and find the most recent mention date.
 *
 * Uses FTS `to_tsquery` with the first few significant words of the bet statement.
 */
export async function queryBetActivity(
  db: Database,
  bet: PendingBet,
  days: number,
): Promise<BetWithActivity> {
  try {
    const rows = await db.execute<{
      recent_count: string
      days_since: string | null
    }>(sql`
      SELECT
        COUNT(*)::text AS recent_count,
        EXTRACT(DAY FROM (NOW() - MAX(captured_at)))::text AS days_since
      FROM captures
      WHERE deleted_at IS NULL
        AND pipeline_status = 'complete'
        AND captured_at >= (NOW() - ${days + ' days'}::interval)
        AND to_tsvector('english', content) @@ plainto_tsquery('english', ${bet.statement})
    `)

    const row = rows.rows[0]
    return {
      ...bet,
      recent_capture_count: row ? parseInt(row.recent_count, 10) : 0,
      days_since_last_mention: row?.days_since != null ? Math.round(parseFloat(row.days_since)) : null,
    }
  } catch (err) {
    logger.warn({ err, betId: bet.id }, '[drift-monitor] failed to query bet activity')
    return { ...bet, recent_capture_count: 0, days_since_last_mention: null }
  }
}

/**
 * Compare entity mention frequency between the current window and the previous window.
 * Returns entities with >50% decline in mention count.
 *
 * Only includes entities with at least 2 mentions in the previous window (filters out
 * one-off mentions that naturally drop to zero).
 */
export async function queryEntityFrequency(
  db: Database,
  windowDays: number,
): Promise<EntityFrequency[]> {
  try {
    const rows = await db.execute<{
      entity_id: string
      entity_name: string
      entity_type: string
      current_count: string
      previous_count: string
    }>(sql`
      WITH current_window AS (
        SELECT el.entity_id, COUNT(*)::int AS cnt
        FROM entity_links el
        JOIN captures c ON c.id = el.capture_id
        WHERE c.deleted_at IS NULL
          AND c.captured_at >= (NOW() - ${windowDays + ' days'}::interval)
        GROUP BY el.entity_id
      ),
      previous_window AS (
        SELECT el.entity_id, COUNT(*)::int AS cnt
        FROM entity_links el
        JOIN captures c ON c.id = el.capture_id
        WHERE c.deleted_at IS NULL
          AND c.captured_at >= (NOW() - ${(windowDays * 2) + ' days'}::interval)
          AND c.captured_at < (NOW() - ${windowDays + ' days'}::interval)
        GROUP BY el.entity_id
      )
      SELECT
        e.id AS entity_id,
        e.name AS entity_name,
        e.entity_type,
        COALESCE(cw.cnt, 0)::text AS current_count,
        pw.cnt::text AS previous_count
      FROM previous_window pw
      JOIN entities e ON e.id = pw.entity_id
      LEFT JOIN current_window cw ON cw.entity_id = pw.entity_id
      WHERE pw.cnt >= 2
        AND (COALESCE(cw.cnt, 0)::float / pw.cnt::float) < 0.5
      ORDER BY pw.cnt DESC
      LIMIT 20
    `)

    return rows.rows.map(r => {
      const current = parseInt(r.current_count, 10)
      const previous = parseInt(r.previous_count, 10)
      return {
        entity_id: r.entity_id,
        entity_name: r.entity_name,
        entity_type: r.entity_type,
        current_count: current,
        previous_count: previous,
        change_pct: previous > 0 ? ((current - previous) / previous) * 100 : 0,
      }
    })
  } catch (err) {
    logger.warn({ err }, '[drift-monitor] failed to query entity frequency')
    return []
  }
}

/**
 * Fetch completed governance sessions from the last N days, including their summary
 * and the last assistant message (which often contains commitments/action items).
 */
export async function queryGovernanceCommitments(
  db: Database,
  days: number,
): Promise<GovernanceCommitment[]> {
  try {
    const rows = await db.execute<{
      session_id: string
      session_date: string
      summary: string | null
      closing_message: string | null
    }>(sql`
      SELECT
        s.id AS session_id,
        s.completed_at::text AS session_date,
        s.summary,
        (
          SELECT sm.content
          FROM session_messages sm
          WHERE sm.session_id = s.id AND sm.role = 'assistant'
          ORDER BY sm.created_at DESC
          LIMIT 1
        ) AS closing_message
      FROM sessions s
      WHERE s.session_type = 'governance'
        AND s.status = 'complete'
        AND s.completed_at >= (NOW() - ${days + ' days'}::interval)
      ORDER BY s.completed_at DESC
    `)

    return rows.rows as GovernanceCommitment[]
  } catch (err) {
    logger.warn({ err }, '[drift-monitor] failed to query governance commitments')
    return []
  }
}

// ============================================================
// Context formatting
// ============================================================

/**
 * Format pending bets with activity data as plain text for LLM context.
 */
export function formatPendingBets(betsWithActivity: BetWithActivity[]): string {
  if (betsWithActivity.length === 0) return '(no pending bets)'

  return betsWithActivity.map(b => {
    const resDate = b.resolution_date ? ` | resolution date: ${b.resolution_date.slice(0, 10)}` : ''
    const activity = b.recent_capture_count > 0
      ? `${b.recent_capture_count} recent captures, last mention ${b.days_since_last_mention ?? '?'} days ago`
      : 'NO recent captures mentioning this bet'
    return `- [${b.domain ?? 'general'}] "${b.statement}" (confidence: ${b.confidence}${resDate}) — created ${b.created_at.slice(0, 10)} — Activity: ${activity}`
  }).join('\n')
}

/**
 * Format governance commitments as plain text for LLM context.
 */
export function formatGovernanceCommitments(commitments: GovernanceCommitment[]): string {
  if (commitments.length === 0) return '(no governance sessions in window)'

  return commitments.map(c => {
    const lines: string[] = []
    lines.push(`Session ${c.session_id.slice(0, 8)} (${c.session_date?.slice(0, 10) ?? 'unknown date'}):`)
    if (c.summary) lines.push(`  Summary: ${c.summary.slice(0, 300)}`)
    if (c.closing_message) lines.push(`  Closing message: ${c.closing_message.slice(0, 500)}`)
    return lines.join('\n')
  }).join('\n\n')
}

/**
 * Format entity frequency data as plain text for LLM context.
 */
export function formatEntityFrequency(entities: EntityFrequency[]): string {
  if (entities.length === 0) return '(no significant entity frequency declines detected)'

  return entities.map(e =>
    `- ${e.entity_name} (${e.entity_type}): ${e.previous_count} mentions (previous window) → ${e.current_count} mentions (current window) [${e.change_pct.toFixed(0)}% change]`,
  ).join('\n')
}

// ============================================================
// Helpers
// ============================================================

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD
}
