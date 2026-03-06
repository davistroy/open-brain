import { z } from 'zod'
import type { Database } from '@open-brain/shared'
import { sql } from 'drizzle-orm'

export const getWeeklyBriefSchema = z.object({
  weeks_ago: z.number().int().min(0).max(52).default(0).describe('How many weeks ago (0 = most recent)'),
})

export type GetWeeklyBriefInput = z.infer<typeof getWeeklyBriefSchema>

interface SkillsLogRow {
  id: string
  skill_name: string
  output: unknown
  created_at: string
}

export async function getWeeklyBriefTool(input: GetWeeklyBriefInput, db: Database): Promise<string> {
  let rows: SkillsLogRow[]

  try {
    if (input.weeks_ago === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await db.execute<any>(
        sql`SELECT id::text, skill_name, output, created_at FROM skills_log WHERE skill_name = 'weekly-brief' ORDER BY created_at DESC LIMIT 1`,
      )
      rows = result.rows
    } else {
      // Find the brief from approximately N weeks ago
      const targetDate = new Date(Date.now() - input.weeks_ago * 7 * 24 * 60 * 60 * 1000)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await db.execute<any>(
        sql`SELECT id::text, skill_name, output, created_at FROM skills_log WHERE skill_name = 'weekly-brief' AND created_at <= ${targetDate.toISOString()}::timestamptz ORDER BY created_at DESC LIMIT 1`,
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

  const output = brief.output
  const content = typeof output === 'string'
    ? output
    : typeof output === 'object' && output !== null && 'content' in output
      ? String((output as Record<string, unknown>).content)
      : JSON.stringify(output, null, 2)

  return `Weekly Brief — ${briefDate}\n${'='.repeat(50)}\n\n${content}`
}
