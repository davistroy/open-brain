import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

// ============================================================
// Types (defined here to avoid circular imports)
// ============================================================

/**
 * Structured output from the weekly brief AI call.
 * All array fields are guaranteed to be present (may be empty).
 */
export interface WeeklyBriefOutput {
  headline: string
  wins: string[]
  blockers: string[]
  risks: string[]
  open_loops: string[]
  next_week_focus: string[]
  avoided_decisions: string[]
  drift_alerts: string[]
  connections: string[]
}

export interface WeeklyBriefResult {
  brief: WeeklyBriefOutput
  captureCount: number
  durationMs: number
  /** UUID of the capture created to store the brief back into the brain */
  savedCaptureId: string | null
}

export interface WeeklyBriefOptions {
  /** How far back to query captures (in days). Default: 7. */
  windowDays?: number
  /** Approximate token budget for assembled captures context. Default: 50_000. */
  tokenBudget?: number
  /** Override the AI model alias. Default: 'synthesis'. */
  modelAlias?: string
  /** Email recipient override — falls back to WEEKLY_BRIEF_EMAIL env var */
  emailTo?: string
}

// ============================================================
// Constants
// ============================================================

// Rough chars-per-token estimate (English prose). Used for budget enforcement.
export const CHARS_PER_TOKEN = 4
export const DEFAULT_TOKEN_BUDGET = 50_000

// Brain view display order for context assembly
export const VIEW_ORDER = ['career', 'work-internal', 'client', 'technical', 'personal']

// ============================================================
// Query functions
// ============================================================

/**
 * Fetch all captures in the time window, ordered by brain_view then captured_at DESC.
 * Does not use SearchService — we want all captures, not semantically ranked ones.
 */
export async function queryCaptures(
  db: Database,
  from: Date,
  to: Date,
): Promise<CaptureRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await db.execute<any>(sql`
    SELECT id, content, capture_type, brain_view, source, tags, captured_at, created_at, updated_at,
           pipeline_status, pipeline_attempts, content_hash
    FROM captures
    WHERE captured_at >= ${from.toISOString()}::timestamptz
      AND captured_at <= ${to.toISOString()}::timestamptz
      AND pipeline_status = 'complete'
    ORDER BY brain_view ASC, captured_at DESC
  `)
  return rows.rows as CaptureRecord[]
}

// ============================================================
// Context assembly
// ============================================================

export interface AssembledContext {
  contextText: string
  capturesByView: Record<string, number>
}

/**
 * Group captures by brain_view, format each capture as plain text,
 * and concatenate into a context string that fits within the char budget.
 *
 * Truncation strategy: process views in priority order. Within each view,
 * captures are newest-first. Drop from the end of each view's list until
 * under budget.
 */
export function assembleContext(
  captures: CaptureRecord[],
  maxChars: number,
): AssembledContext {
  // Group by view
  const byView = new Map<string, CaptureRecord[]>()
  for (const c of captures) {
    const view = c.brain_view ?? 'unknown'
    if (!byView.has(view)) byView.set(view, [])
    byView.get(view)!.push(c)
  }

  // Determine display order (configured views first, then any extras alphabetically)
  const allViews = [...byView.keys()]
  const orderedViews = [
    ...VIEW_ORDER.filter(v => byView.has(v)),
    ...allViews.filter(v => !VIEW_ORDER.includes(v)).sort(),
  ]

  const capturesByView: Record<string, number> = {}
  const sections: string[] = []
  let totalChars = 0

  for (const view of orderedViews) {
    const viewCaptures = byView.get(view) ?? []
    capturesByView[view] = viewCaptures.length

    const lines: string[] = []
    for (const c of viewCaptures) {
      const line = formatCapture(c)
      if (totalChars + line.length > maxChars) {
        logger.debug({ view, truncatedAt: lines.length }, '[weekly-brief] context budget reached — truncating')
        break
      }
      lines.push(line)
      totalChars += line.length
    }

    if (lines.length > 0) {
      sections.push(`=== ${view.toUpperCase()} (${lines.length} captures) ===\n${lines.join('\n')}`)
    }
  }

  return { contextText: sections.join('\n\n'), capturesByView }
}

// ============================================================
// Helpers
// ============================================================

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD
}

export function formatCapture(c: CaptureRecord): string {
  const date = fmtDate(new Date(c.captured_at))
  const tags = c.tags && c.tags.length > 0 ? ` [${c.tags.join(', ')}]` : ''
  return `[${date}] [${c.capture_type}]${tags} ${c.content}\n`
}
