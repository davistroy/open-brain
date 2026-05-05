import { sql } from 'drizzle-orm'
import { ValidationError } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a skills_log row returned by intelligence queries.
 */
export interface IntelligenceLogRow {
  [key: string]: unknown
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
 * Formatted intelligence log entry returned to callers.
 * Matches the existing wire shape produced by formatLogEntry() in the route.
 */
export interface IntelligenceEntry {
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
 * Combined summary of latest results for both intelligence skills.
 * Returned by getSummary() for the dashboard's initial load.
 */
export interface IntelligenceSummary {
  connections: IntelligenceEntry | null
  drift: IntelligenceEntry | null
}

// ---------------------------------------------------------------------------
// Allowlist — single source of truth (A112)
// ---------------------------------------------------------------------------

/**
 * Allowed intelligence skill names for /latest and /history queries.
 * This is the ONLY place this set is declared — the route delegates here.
 *
 * NOTE (A112): The trigger endpoint uses a separate allowlist
 * (INTELLIGENCE_TRIGGER_SKILLS) because the trigger endpoint accepts
 * 'daily-sweep-skill' in addition to the two read-only read-skills.
 * If the trigger endpoint's allowlist needs to change, update it there;
 * if the read-skill allowlist needs to change, update INTELLIGENCE_SKILLS here.
 */
export const INTELLIGENCE_SKILLS = new Set([
  'daily-connections',
  'drift-monitor',
  'daily-sweep-skill',
])

// ---------------------------------------------------------------------------
// IntelligenceService
// ---------------------------------------------------------------------------

/**
 * IntelligenceService — read access to skills_log for intelligence skills.
 *
 * Encapsulates:
 * - Allowlist validation (assertSkillName)
 * - getLatest(skillName)  — most-recent skills_log row (COALESCE result/output_summary)
 * - getHistory(skillName, limit) — historical entries
 * - getSummary()          — latest for both daily-connections + drift-monitor in one query
 *
 * The route is a thin delegator that only handles HTTP concerns (query-param
 * parsing, c.json, limit capping).
 */
export class IntelligenceService {
  constructor(private readonly db: Database) {}

  /**
   * Validates that the provided skill name is in the allowlist.
   * Throws ValidationError (400) if unknown — prevents arbitrary SQL injection
   * into skill_name filter and surfaces clean user-facing errors.
   */
  private assertSkillName(skillName: string): void {
    if (!INTELLIGENCE_SKILLS.has(skillName)) {
      throw new ValidationError(
        `Unknown intelligence skill: '${skillName}'. Valid skills: ${Array.from(INTELLIGENCE_SKILLS).join(', ')}`,
      )
    }
  }

  /**
   * Returns the most-recent skills_log row for the given skill,
   * or null if no entries exist.
   *
   * Preserves COALESCE behavior: result JSONB is returned as-is;
   * callers may fall back to output_summary when result is null.
   */
  async getLatest(skillName: string): Promise<IntelligenceEntry | null> {
    this.assertSkillName(skillName)

    const rows = await this.db.execute<IntelligenceLogRow>(sql`
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
      WHERE skill_name = ${skillName}
      ORDER BY created_at DESC
      LIMIT 1
    `)

    if (rows.rows.length === 0) {
      return null
    }

    return formatEntry(rows.rows[0])
  }

  /**
   * Returns recent skills_log entries for the given skill, newest first.
   * Limit is caller-supplied (the route clamps it to ≤50 before passing in).
   */
  async getHistory(skillName: string, limit: number): Promise<IntelligenceEntry[]> {
    this.assertSkillName(skillName)

    const rows = await this.db.execute<IntelligenceLogRow>(sql`
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
      WHERE skill_name = ${skillName}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)

    return rows.rows.map(formatEntry)
  }

  /**
   * Returns the latest result for both daily-connections and drift-monitor
   * in a single query — optimized for the Intelligence tab initial load.
   * Non-validated path (only queries the two hardcoded skill names).
   */
  async getSummary(): Promise<IntelligenceSummary> {
    const rows = await this.db.execute<IntelligenceLogRow>(sql`
      SELECT DISTINCT ON (skill_name)
        id::text,
        skill_name,
        capture_id::text,
        input_summary,
        output_summary,
        result,
        duration_ms,
        created_at
      FROM skills_log
      WHERE skill_name IN ('daily-connections', 'drift-monitor')
      ORDER BY skill_name, created_at DESC
    `)

    const bySkill: Record<string, IntelligenceEntry | null> = {
      'daily-connections': null,
      'drift-monitor': null,
    }

    for (const row of rows.rows) {
      if (INTELLIGENCE_SKILLS.has(row.skill_name)) {
        bySkill[row.skill_name] = formatEntry(row)
      }
    }

    return {
      connections: bySkill['daily-connections'],
      drift: bySkill['drift-monitor'],
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a raw skills_log row into the shape expected by the web dashboard.
 * Preserves the existing wire contract from the pre-extraction formatLogEntry().
 */
function formatEntry(row: IntelligenceLogRow): IntelligenceEntry {
  return {
    id: row.id,
    skill_name: row.skill_name,
    capture_id: row.capture_id,
    input_summary: row.input_summary,
    output_summary: row.output_summary,
    result: row.result ?? null,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  }
}
