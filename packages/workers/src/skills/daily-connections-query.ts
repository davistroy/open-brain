import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

// ============================================================
// Types
// ============================================================

/**
 * Structured output from the daily connections AI call.
 */
export interface DailyConnectionsOutput {
  summary: string
  connections: ConnectionItem[]
  meta_pattern: string | null
}

export interface ConnectionItem {
  theme: string
  captures: string[]
  insight: string
  confidence: 'high' | 'medium' | 'low'
  domains: string[]
}

export interface DailyConnectionsResult {
  output: DailyConnectionsOutput
  captureCount: number
  durationMs: number
  /** UUID of the capture created to store the connections back into the brain */
  savedCaptureId: string | null
}

export interface DailyConnectionsOptions {
  /** How far back to query captures (in days). Default: 7. */
  windowDays?: number
  /** Approximate token budget for assembled captures context. Default: 30_000. */
  tokenBudget?: number
  /** Override the AI model alias. Default: 'synthesis'. */
  modelAlias?: string
}

/**
 * An entity pair co-occurrence record.
 */
export interface EntityCoOccurrence {
  entity_a_name: string
  entity_a_type: string
  entity_b_name: string
  entity_b_type: string
  co_occurrence_count: number
}

// ============================================================
// Constants
// ============================================================

/** Rough chars-per-token estimate (English prose). Used for budget enforcement. */
export const CHARS_PER_TOKEN = 4
export const DEFAULT_TOKEN_BUDGET = 30_000

/** Brain view display order for context assembly. */
export const VIEW_ORDER = ['career', 'work-internal', 'client', 'technical', 'personal']

// ============================================================
// Query functions
// ============================================================

/**
 * Fetch all complete captures in the time window, ordered by brain_view then captured_at DESC.
 * Excludes deleted captures.
 */
export async function queryRecentCaptures(
  db: Database,
  windowDays: number,
): Promise<CaptureRecord[]> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  const rows = await db.execute<{
    id: string
    content: string
    capture_type: string
    brain_view: string
    source: string
    tags: string[]
    captured_at: string
    created_at: string
    updated_at: string
    pipeline_status: string
    pipeline_attempts: number
    content_hash: string
  }>(sql`
    SELECT id, content, capture_type, brain_view, source, tags, captured_at, created_at, updated_at,
           pipeline_status, pipeline_attempts, content_hash
    FROM captures
    WHERE captured_at >= ${windowStart.toISOString()}::timestamptz
      AND captured_at <= ${now.toISOString()}::timestamptz
      AND pipeline_status = 'complete'
      AND deleted_at IS NULL
    ORDER BY brain_view ASC, captured_at DESC
  `)

  return rows.rows as unknown as CaptureRecord[]
}

/**
 * Build entity co-occurrence data from entity_links for the given capture IDs.
 *
 * Queries entity_links joined with entities to find entity pairs that appear
 * together across different captures. Returns the top N pairs by co-occurrence count.
 *
 * Uses the entity_relationships table (pre-computed co-occurrence graph) filtered
 * to entities appearing in the provided capture set.
 */
export async function buildEntityCoOccurrence(
  db: Database,
  captureIds: string[],
  topN: number = 10,
): Promise<EntityCoOccurrence[]> {
  if (captureIds.length === 0) return []

  try {
    const rows = await db.execute<{
      entity_a_name: string
      entity_a_type: string
      entity_b_name: string
      entity_b_type: string
      co_occurrence_count: number
    }>(sql`
      WITH relevant_entities AS (
        SELECT DISTINCT el.entity_id
        FROM entity_links el
        WHERE el.capture_id = ANY(${captureIds}::uuid[])
      )
      SELECT
        ea.name AS entity_a_name,
        ea.entity_type AS entity_a_type,
        eb.name AS entity_b_name,
        eb.entity_type AS entity_b_type,
        er.co_occurrence_count
      FROM entity_relationships er
      JOIN entities ea ON ea.id = er.entity_id_a
      JOIN entities eb ON eb.id = er.entity_id_b
      WHERE er.entity_id_a IN (SELECT entity_id FROM relevant_entities)
        AND er.entity_id_b IN (SELECT entity_id FROM relevant_entities)
      ORDER BY er.co_occurrence_count DESC
      LIMIT ${topN}
    `)

    return rows.rows as EntityCoOccurrence[]
  } catch (err) {
    logger.warn({ err }, '[daily-connections] failed to query entity co-occurrence — returning empty')
    return []
  }
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
        logger.debug({ view, truncatedAt: lines.length }, '[daily-connections] context budget reached — truncating')
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

/**
 * Format entity co-occurrence data as plain text for LLM context.
 */
export function formatCoOccurrence(pairs: EntityCoOccurrence[]): string {
  if (pairs.length === 0) return '(no entity co-occurrence data available)'

  const lines = pairs.map(
    p => `- ${p.entity_a_name} (${p.entity_a_type}) + ${p.entity_b_name} (${p.entity_b_type}): ${p.co_occurrence_count} co-occurrences`,
  )
  return lines.join('\n')
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
