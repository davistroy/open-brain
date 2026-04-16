import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

// ============================================================
// Query helpers extracted from morning-brief.ts
// These are the 4 database query functions used by MorningBriefSkill.
// Exported separately for testability and Phase 6 reuse (email triage).
// ============================================================

/**
 * Query captures from the previous day, excluding auto-generated content.
 * Returns at most 10 captures, ordered by created_at.
 */
export async function queryYesterdayCaptures(
  db: Database,
  now: Date,
): Promise<Array<{ id: string; content: string }>> {
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)

  try {
    const rows = await db.execute<{ id: string; content: string }>(sql`
      SELECT id, content
      FROM captures
      WHERE created_at >= ${yesterdayStart.toISOString()}::timestamptz
        AND created_at < ${todayStart.toISOString()}::timestamptz
        AND deleted_at IS NULL
        AND NOT (tags && ARRAY['skill-output', 'connections', 'daily-sweep']::text[])
      ORDER BY created_at ASC
      LIMIT 10
    `)
    return rows.rows as Array<{ id: string; content: string }>
  } catch (err) {
    logger.warn({ err }, '[morning-brief] failed to query yesterday captures')
    return []
  }
}

/**
 * Query captures from the last 3 days for open loop detection.
 */
export async function queryRecentCaptures(
  db: Database,
  now: Date,
): Promise<Array<{ content: string }>> {
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)

  try {
    const rows = await db.execute<{ content: string }>(sql`
      SELECT content
      FROM captures
      WHERE created_at >= ${threeDaysAgo.toISOString()}::timestamptz
        AND deleted_at IS NULL
        AND NOT (tags && ARRAY['skill-output', 'connections', 'daily-sweep']::text[])
      ORDER BY created_at DESC
      LIMIT 100
    `)
    return rows.rows as Array<{ content: string }>
  } catch (err) {
    logger.warn({ err }, '[morning-brief] failed to query recent captures')
    return []
  }
}

/**
 * Query people mentioned in captures from the last 3 days.
 * Joins entity_links -> entities, groups by person, returns most recent capture snippet.
 */
export async function queryRecentPeople(
  db: Database,
  now: Date,
): Promise<Array<{ name: string; snippet: string }>> {
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)

  try {
    const rows = await db.execute<{ name: string; snippet: string }>(sql`
      SELECT DISTINCT ON (e.canonical_name)
        e.canonical_name AS name,
        LEFT(c.content, 80) AS snippet
      FROM entity_links el
      JOIN entities e ON e.id = el.entity_id
      JOIN captures c ON c.id = el.capture_id
      WHERE e.entity_type = 'person'
        AND c.created_at >= ${threeDaysAgo.toISOString()}::timestamptz
        AND c.deleted_at IS NULL
        AND LOWER(e.canonical_name) NOT IN ('troy davis', 'troy')
      ORDER BY e.canonical_name, c.created_at DESC
      LIMIT 5
    `)
    return rows.rows as Array<{ name: string; snippet: string }>
  } catch (err) {
    logger.warn({ err }, '[morning-brief] failed to query recent people')
    return []
  }
}

/**
 * Query yesterday's evening captures (after 6 PM) for mentions of today's
 * day name or "tomorrow" followed by activity text.
 */
export async function queryEveningCaptures(
  db: Database,
  now: Date,
): Promise<Array<{ content: string }>> {
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayEvening = new Date(todayStart)
  yesterdayEvening.setDate(yesterdayEvening.getDate() - 1)
  yesterdayEvening.setHours(18, 0, 0, 0)

  try {
    const rows = await db.execute<{ content: string }>(sql`
      SELECT content
      FROM captures
      WHERE created_at >= ${yesterdayEvening.toISOString()}::timestamptz
        AND created_at < ${todayStart.toISOString()}::timestamptz
        AND deleted_at IS NULL
        AND NOT (tags && ARRAY['skill-output', 'connections', 'daily-sweep']::text[])
      ORDER BY created_at DESC
      LIMIT 20
    `)
    return rows.rows as Array<{ content: string }>
  } catch (err) {
    logger.warn({ err }, '[morning-brief] failed to query evening captures')
    return []
  }
}
