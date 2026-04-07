import { z } from 'zod'
import type { Database } from '@open-brain/shared'
import { sql } from 'drizzle-orm'

export const getWeeklyBriefSchema = z.object({
  weeks_ago: z.number().int().min(0).max(52).default(0).describe('How many weeks ago (0 = most recent)'),
})

export type GetWeeklyBriefInput = z.infer<typeof getWeeklyBriefSchema>

type SkillsLogRow = {
  id: string
  skill_name: string
  output_summary: string | null
  result: unknown
  created_at: string
}

export async function getWeeklyBriefTool(input: GetWeeklyBriefInput, db: Database): Promise<string> {
  let rows: SkillsLogRow[]

  try {
    if (input.weeks_ago === 0) {
      const result = await db.execute<SkillsLogRow>(
        sql`SELECT id::text, skill_name, output_summary, result, created_at FROM skills_log WHERE skill_name = 'weekly-brief' ORDER BY created_at DESC LIMIT 1`,
      )
      rows = result.rows
    } else {
      // Find the brief from approximately N weeks ago
      const targetDate = new Date(Date.now() - input.weeks_ago * 7 * 24 * 60 * 60 * 1000)
      const result = await db.execute<SkillsLogRow>(
        sql`SELECT id::text, skill_name, output_summary, result, created_at FROM skills_log WHERE skill_name = 'weekly-brief' AND created_at <= ${targetDate.toISOString()}::timestamptz ORDER BY created_at DESC LIMIT 1`,
      )
      rows = result.rows
    }
  } catch {
    // skills_log table may not exist yet (Phase 11)
    return `Weekly briefs are not yet available. The weekly brief skill is implemented in a later phase.\n\nOnce enabled, weekly briefs will be automatically generated every Sunday and accessible here.`
  }

  if (rows.length === 0) {
    if (input.weeks_ago === 0) {
      return `No weekly briefs generated yet.\n\nWeekly briefs are generated automatically each Sunday once the weekly-brief skill is enabled. You can also trigger one manually via the admin API.`
    }
    return `No weekly brief found from ${input.weeks_ago} week${input.weeks_ago !== 1 ? 's' : ''} ago.`
  }

  const brief = rows[0]
  const briefDate = new Date(brief.created_at).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  // Prefer result (JSONB, full structured output) over output_summary (truncated text)
  const output = brief.result ?? brief.output_summary
  let content: string
  if (typeof output === 'string') {
    content = output
  } else if (typeof output === 'object' && output !== null && 'content' in output) {
    content = String((output as Record<string, unknown>).content)
  } else if (output != null) {
    content = JSON.stringify(output, null, 2)
  } else {
    content = 'No brief content available.'
  }

  return `Weekly Brief — ${briefDate}\n${'='.repeat(50)}\n\n${content}`
}
