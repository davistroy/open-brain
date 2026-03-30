import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'

/**
 * A row from the skills_log table (only the columns we query here).
 */
export type SkillsLogRow = {
  id: string
  skill_name: string
  input_summary: string | null
  output_summary: string | null
  duration_ms: number | null
  created_at: Date | string
}

/**
 * Extended row shape for the per-skill logs endpoint (includes result + capture_id).
 */
export type SkillsLogDetailRow = {
  id: string
  skill_name: string
  capture_id: string | null
  input_summary: string | null
  output_summary: string | null
  result: Record<string, unknown> | null
  duration_ms: number | null
  created_at: Date | string
}

/**
 * Get the most recent skills_log row per skill_name.
 * Uses DISTINCT ON which isn't expressible in Drizzle query builder.
 */
export async function getLatestRunPerSkill(db: Database): Promise<SkillsLogRow[]> {
  const rows = await db.execute<SkillsLogRow>(sql`
    SELECT DISTINCT ON (skill_name)
      id::text,
      skill_name,
      input_summary,
      output_summary,
      duration_ms,
      created_at
    FROM skills_log
    ORDER BY skill_name, created_at DESC
  `)
  return rows.rows
}

/**
 * Get recent log entries for a specific skill.
 */
export async function getLogsForSkill(
  db: Database,
  name: string,
  limit: number,
): Promise<SkillsLogDetailRow[]> {
  const rows = await db.execute<SkillsLogDetailRow>(sql`
    SELECT
      id::text,
      skill_name,
      capture_id::text,
      input_summary,
      output_summary,
      result,
      duration_ms,
      created_at
    FROM skills_log
    WHERE skill_name = ${name}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)
  return rows.rows
}
