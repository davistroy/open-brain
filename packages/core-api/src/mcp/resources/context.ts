import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'

/**
 * Generate a markdown summary of the current brain context.
 * Used by the MCP resource `open_brain://context`.
 * Pure SQL aggregation — no LLM calls, fast response (<500ms).
 */
export async function generateContextSummary(db: Database): Promise<string> {
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const dateStr = now.toISOString().split('T')[0]

  const sections: string[] = [`# Open Brain Context — ${dateStr}\n`]

  // Section 1: Capture activity summary (last 7 days)
  try {
    const viewCounts = await db.execute<{ brain_view: string; count: string }>(sql`
      SELECT brain_view, COUNT(*)::text as count
      FROM captures
      WHERE deleted_at IS NULL
        AND pipeline_status = 'complete'
        AND created_at >= ${sevenDaysAgo.toISOString()}::timestamptz
      GROUP BY brain_view
      ORDER BY count DESC
    `)

    sections.push('## Active Focus Areas (Last 7 Days)\n')
    if (viewCounts.rows.length === 0) {
      sections.push('No captures in the last 7 days.\n')
    } else {
      for (const row of viewCounts.rows) {
        sections.push(`- **${row.brain_view}**: ${row.count} captures`)
      }
      sections.push('')
    }
  } catch {
    sections.push('## Active Focus Areas\n\n_Unable to query capture activity._\n')
  }

  // Section 2: Key entities (top 15 by mention count in last 7 days)
  try {
    const entities = await db.execute<{ name: string; entity_type: string; mention_count: string; last_seen_at: string }>(sql`
      SELECT e.name, e.entity_type, COUNT(el.id)::text as mention_count, MAX(e.last_seen_at)::text as last_seen_at
      FROM entities e
      JOIN entity_links el ON el.entity_id = e.id
      JOIN captures c ON c.id = el.capture_id
      WHERE c.deleted_at IS NULL
        AND c.pipeline_status = 'complete'
        AND c.created_at >= ${sevenDaysAgo.toISOString()}::timestamptz
      GROUP BY e.id, e.name, e.entity_type
      ORDER BY COUNT(el.id) DESC
      LIMIT 15
    `)

    sections.push('## Key Entities (Last 7 Days)\n')
    if (entities.rows.length === 0) {
      sections.push('No entities found in recent captures.\n')
    } else {
      sections.push('| Entity | Type | Mentions | Last Seen |')
      sections.push('|--------|------|----------|-----------|')
      for (const row of entities.rows) {
        const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).toISOString().split('T')[0] : '\u2014'
        sections.push(`| ${row.name} | ${row.entity_type} | ${row.mention_count} | ${lastSeen} |`)
      }
      sections.push('')
    }
  } catch {
    sections.push('## Key Entities\n\n_Unable to query entities._\n')
  }

  // Section 3: Open questions (capture_type='question', last 7 days)
  try {
    const questions = await db.execute<{ content: string; created_at: string; brain_view: string }>(sql`
      SELECT c.content, c.created_at::text, c.brain_view
      FROM captures c
      WHERE c.capture_type = 'question'
        AND c.pipeline_status = 'complete'
        AND c.deleted_at IS NULL
        AND c.created_at >= ${sevenDaysAgo.toISOString()}::timestamptz
      ORDER BY c.created_at DESC
      LIMIT 10
    `)

    sections.push('## Open Questions\n')
    if (questions.rows.length === 0) {
      sections.push('No recent questions.\n')
    } else {
      for (const row of questions.rows) {
        const date = new Date(row.created_at).toISOString().split('T')[0]
        const truncated = row.content.length > 200 ? row.content.slice(0, 200) + '...' : row.content
        sections.push(`- **[${date}]** (${row.brain_view}) ${truncated}`)
      }
      sections.push('')
    }
  } catch {
    sections.push('## Open Questions\n\n_Unable to query questions._\n')
  }

  // Section 4: Recent decisions
  try {
    const decisions = await db.execute<{ content: string; created_at: string; brain_view: string }>(sql`
      SELECT c.content, c.created_at::text, c.brain_view
      FROM captures c
      WHERE c.capture_type = 'decision'
        AND c.pipeline_status = 'complete'
        AND c.deleted_at IS NULL
        AND c.created_at >= ${sevenDaysAgo.toISOString()}::timestamptz
      ORDER BY c.created_at DESC
      LIMIT 5
    `)

    sections.push('## Recent Decisions\n')
    if (decisions.rows.length === 0) {
      sections.push('No recent decisions.\n')
    } else {
      for (const row of decisions.rows) {
        const date = new Date(row.created_at).toISOString().split('T')[0]
        const truncated = row.content.length > 200 ? row.content.slice(0, 200) + '...' : row.content
        sections.push(`- **[${date}]** (${row.brain_view}) ${truncated}`)
      }
      sections.push('')
    }
  } catch {
    sections.push('## Recent Decisions\n\n_Unable to query decisions._\n')
  }

  // Section 5: Capture type distribution
  try {
    const typeCounts = await db.execute<{ capture_type: string; count: string }>(sql`
      SELECT capture_type, COUNT(*)::text as count
      FROM captures
      WHERE deleted_at IS NULL
        AND pipeline_status = 'complete'
        AND created_at >= ${sevenDaysAgo.toISOString()}::timestamptz
      GROUP BY capture_type
      ORDER BY count DESC
    `)

    sections.push('## Capture Types (Last 7 Days)\n')
    if (typeCounts.rows.length === 0) {
      sections.push('No captures.\n')
    } else {
      for (const row of typeCounts.rows) {
        sections.push(`- ${row.capture_type}: ${row.count}`)
      }
      sections.push('')
    }
  } catch {
    sections.push('## Capture Types\n\n_Unable to query capture types._\n')
  }

  return sections.join('\n')
}
