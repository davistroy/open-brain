import { sql } from 'drizzle-orm'
import type { Database, PipelineEventStage } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { SWEEPABLE_STATUSES } from '../lib/sweepable-statuses.js'
import { readHeartbeats } from '../lib/heartbeat.js'
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
      stage: PipelineEventStage
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

// ============================================================
// Item 3.1: embedding stall, stuck captures, pipeline success share
// ============================================================

export interface EmbedStallStats {
  /** Live captures with no embedding, older than the age gate, not `failed`/`deleted`. */
  stalled: number
  /** All live captures with no embedding, any age or status (includes the deliberate `failed` ones). */
  unembedded: number
  /** Created-at of the oldest stalled capture, or null when none. */
  oldestStalledAt: Date | null
  /** Newest `updated_at` among embedded live captures: approximate last embedding activity. */
  newestEmbeddedAt: Date | null
}

function toCount(v: unknown): number | null {
  const n = Number(v)
  return v === undefined || v === null || Number.isNaN(n) ? null : n
}

function toDate(v: unknown): Date | null {
  if (v === undefined || v === null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Captures that have been waiting for an embedding longer than `minAgeHours`.
 * `failed` captures are excluded on purpose: they are an accepted terminal state
 * (e.g. content the provider refused) and must not hold the alert open forever.
 * Returns null when the query fails or returns an unexpected shape, so the caller
 * treats the condition as NOT OBSERVED (an open alert is held, never resolved).
 */
export async function queryEmbedStall(db: Database, minAgeHours: number): Promise<EmbedStallStats | null> {
  try {
    const cutoff = new Date(Date.now() - minAgeHours * 3_600_000)
    const rows = await db.execute<{
      stalled: string
      unembedded: string
      oldest_stalled_at: string | null
      newest_embedded_at: string | null
    }>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE embedding IS NULL
            AND created_at < ${cutoff.toISOString()}::timestamptz
            AND pipeline_status NOT IN ('failed', 'deleted')
        )::text AS stalled,
        COUNT(*) FILTER (WHERE embedding IS NULL)::text AS unembedded,
        MIN(created_at) FILTER (
          WHERE embedding IS NULL
            AND created_at < ${cutoff.toISOString()}::timestamptz
            AND pipeline_status NOT IN ('failed', 'deleted')
        ) AS oldest_stalled_at,
        MAX(updated_at) FILTER (WHERE embedding IS NOT NULL) AS newest_embedded_at
      FROM captures
      WHERE deleted_at IS NULL
    `)
    const row = rows.rows[0]
    const stalled = toCount(row?.stalled)
    const unembedded = toCount(row?.unembedded)
    if (stalled === null || unembedded === null) return null
    return {
      stalled,
      unembedded,
      oldestStalledAt: toDate(row?.oldest_stalled_at),
      newestEmbeddedAt: toDate(row?.newest_embedded_at),
    }
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] embed-stall query failed — condition not observed')
    return null
  }
}

/**
 * Live captures sitting at a sweepable status for more than 24 hours: the daily
 * sweep should have recovered them. Statuses come only from SWEEPABLE_STATUSES.
 * Returns null on error.
 */
export async function queryStuckCaptures(db: Database): Promise<number | null> {
  try {
    const cutoff = new Date(Date.now() - 24 * 3_600_000)
    const statuses = sql.join(SWEEPABLE_STATUSES.map(st => sql`${st}`), sql`, `)
    const rows = await db.execute<{ stuck: string }>(sql`
      SELECT COUNT(*)::text AS stuck
      FROM captures
      WHERE deleted_at IS NULL
        AND pipeline_status IN (${statuses})
        AND created_at < ${cutoff.toISOString()}::timestamptz
    `)
    return toCount(rows.rows[0]?.stuck)
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] stuck-capture query failed — gauge skipped')
    return null
  }
}

/**
 * Share (0..1) of live captures created in the last `days` days, and older than
 * 2 hours (still in flight otherwise), that reached `complete`. Null when there
 * are none or the query fails.
 */
export async function queryPipelineSuccessShare(db: Database, days: number): Promise<number | null> {
  try {
    const since = new Date(Date.now() - days * 86_400_000)
    const settled = new Date(Date.now() - 2 * 3_600_000)
    const rows = await db.execute<{ complete_count: string; total_count: string }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE pipeline_status = 'complete')::text AS complete_count,
        COUNT(*)::text AS total_count
      FROM captures
      WHERE deleted_at IS NULL
        AND created_at >= ${since.toISOString()}::timestamptz
        AND created_at < ${settled.toISOString()}::timestamptz
    `)
    const complete = toCount(rows.rows[0]?.complete_count)
    const total = toCount(rows.rows[0]?.total_count)
    if (complete === null || total === null || total === 0) return null
    return complete / total
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] success-share query failed — gauge skipped')
    return null
  }
}

// ============================================================
// Item 3.3: per-source freshness (heartbeats + newest capture per source)
// ============================================================

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

interface FreshnessRule {
  maxAgeMs: number
  /** `meta.latest_bill_date` older than this is stale (gas only). */
  maxBillAgeMs?: number
}

/** Expected sources and their thresholds (plan item 3.3, task 3). */
export const SOURCE_FRESHNESS_RULES: Readonly<Record<string, FreshnessRule>> = {
  gas: { maxAgeMs: 48 * HOUR_MS, maxBillAgeMs: 40 * DAY_MS },
  actual: { maxAgeMs: 36 * HOUR_MS },
  'email:gmail': { maxAgeMs: 36 * HOUR_MS },
  'email:hotmail': { maxAgeMs: 36 * HOUR_MS },
  'secret-rotation': { maxAgeMs: 35 * DAY_MS },
  'memory-consolidation': { maxAgeMs: 8 * DAY_MS },
}

export const EXPECTED_HEARTBEAT_SOURCES: readonly string[] = Object.keys(SOURCE_FRESHNESS_RULES)

export interface SourceFreshness {
  source: string
  stale: boolean
  /** Human-readable cause when stale; empty otherwise. */
  reason: string
  /** Seconds since `last_success_at`; null when the source has never succeeded. */
  ageSeconds: number | null
  lastSuccessAt: string | null
  ok: boolean
  errors: string[]
}

export interface CaptureSourceAge {
  source: string
  newestAt: Date
  ageDays: number
  /** Older than 7 days: listed in the summary, raises no alert. */
  quiet: boolean
}

export interface SourceFreshnessResult {
  sources: SourceFreshness[]
  captureSources: CaptureSourceAge[]
}

function fmtHours(ms: number): string {
  const h = ms / HOUR_MS
  return h >= 48 ? `${Math.floor(h / 24)} d` : `${Math.floor(h)} h`
}

/**
 * Per-source freshness. A source with no record is omitted (not observed: the
 * baseline step writes it). Returns null when the heartbeat read fails, so the
 * caller holds every open `source-stale:*` alert instead of resolving them.
 * The capture-source ages are best-effort and never fail the result.
 */
export async function querySourceFreshness(db: Database, now: Date): Promise<SourceFreshnessResult | null> {
  let records: Awaited<ReturnType<typeof readHeartbeats>>
  try {
    records = await readHeartbeats(db)
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] failed to read heartbeats — source freshness not observed')
    return null
  }

  const sources: SourceFreshness[] = []
  for (const [source, rule] of Object.entries(SOURCE_FRESHNESS_RULES)) {
    const rec = records.get(source)
    if (!rec) continue
    const lastMs = rec.last_success_at ? new Date(rec.last_success_at).getTime() : NaN
    const hasSuccess = !Number.isNaN(lastMs)
    const ageMs = hasSuccess ? now.getTime() - lastMs : null
    const reasons: string[] = []
    if (!rec.ok) {
      reasons.push(`last run failed${rec.errors.length > 0 ? `: ${rec.errors[0]}` : ''}`)
    }
    if (ageMs === null) reasons.push('no successful run recorded')
    else if (ageMs > rule.maxAgeMs) reasons.push(`last success ${fmtHours(ageMs)} ago (limit ${fmtHours(rule.maxAgeMs)})`)
    if (rule.maxBillAgeMs !== undefined && typeof rec.meta.latest_bill_date === 'string') {
      const billMs = new Date(rec.meta.latest_bill_date).getTime()
      if (!Number.isNaN(billMs) && now.getTime() - billMs > rule.maxBillAgeMs) {
        reasons.push(`newest bill dated ${rec.meta.latest_bill_date.slice(0, 10)} (limit ${fmtHours(rule.maxBillAgeMs)})`)
      }
    }
    sources.push({
      source,
      stale: reasons.length > 0,
      reason: reasons.join('; '),
      ageSeconds: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 1000)),
      lastSuccessAt: hasSuccess ? rec.last_success_at : null,
      ok: rec.ok,
      errors: rec.errors,
    })
  }

  const captureSources: CaptureSourceAge[] = []
  try {
    const rows = await db.execute<{ source: string; newest: string | Date | null }>(sql`
      SELECT source, MAX(created_at) AS newest
      FROM captures
      WHERE deleted_at IS NULL AND source IN ('voice', 'slack', 'email')
      GROUP BY source
    `)
    for (const row of rows?.rows ?? []) {
      const newest = toDate(row?.newest)
      if (!newest || typeof row.source !== 'string') continue
      const ageDays = Math.floor((now.getTime() - newest.getTime()) / DAY_MS)
      captureSources.push({ source: row.source, newestAt: newest, ageDays, quiet: ageDays > 7 })
    }
  } catch (err) {
    logger.warn({ err }, '[pipeline-health] failed to read newest capture per source')
  }

  return { sources, captureSources }
}
