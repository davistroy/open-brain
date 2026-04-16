import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

// ============================================================
// Query helpers extracted from morning-brief.ts
// These are the 5 database query functions used by MorningBriefSkill.
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

// ============================================================
// Email triage — overnight email classifications
// ============================================================

/** Categories that get subject-level detail in the morning brief */
export const PRIORITY_EMAIL_CATEGORIES = new Set([
  'Financial & Banking',
  'Work & Office',
  'Jamie',
  'Ashley',
  'Account & Security',
])

export interface OvernightEmailGroup {
  category: string
  count: number
  topSubjects: string[]
}

/**
 * Query email classifications processed since `since`, grouped by category.
 * Returns priority categories first (with top 3 subjects), then remaining
 * categories ordered by count descending.
 */
export async function queryOvernightEmail(
  db: Database,
  since: Date,
): Promise<OvernightEmailGroup[]> {
  try {
    // Step 1: Get counts per category
    const countRows = await db.execute<{ category: string; count: string }>(sql`
      SELECT category, COUNT(*)::text AS count
      FROM email_classifications
      WHERE processed_at >= ${since.toISOString()}::timestamptz
      GROUP BY category
      ORDER BY COUNT(*) DESC
    `)

    if (!countRows.rows || countRows.rows.length === 0) return []

    const categories = countRows.rows as Array<{ category: string; count: string }>

    // Step 2: For priority categories, fetch top 3 subjects
    const results: OvernightEmailGroup[] = []

    for (const row of categories) {
      const isPriority = PRIORITY_EMAIL_CATEGORIES.has(row.category)
      let topSubjects: string[] = []

      if (isPriority) {
        const subjectRows = await db.execute<{ subject: string }>(sql`
          SELECT COALESCE(subject, '(no subject)') AS subject
          FROM email_classifications
          WHERE processed_at >= ${since.toISOString()}::timestamptz
            AND category = ${row.category}
          ORDER BY processed_at DESC
          LIMIT 3
        `)
        topSubjects = (subjectRows.rows as Array<{ subject: string }>).map(r => r.subject)
      }

      results.push({
        category: row.category,
        count: parseInt(row.count, 10),
        topSubjects,
      })
    }

    // Sort: priority categories first, then by count descending
    results.sort((a, b) => {
      const aPri = PRIORITY_EMAIL_CATEGORIES.has(a.category) ? 0 : 1
      const bPri = PRIORITY_EMAIL_CATEGORIES.has(b.category) ? 0 : 1
      if (aPri !== bPri) return aPri - bPri
      return b.count - a.count
    })

    return results
  } catch (err) {
    logger.warn({ err }, '[morning-brief] failed to query overnight email')
    return []
  }
}
