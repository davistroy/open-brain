#!/usr/bin/env tsx
/**
 * scripts/backfill-briefs.ts — One-time backfill: skills_log → briefs table
 *
 * Reads all historical skills_log rows for the 4 brief-producing skills
 * (weekly-brief, daily-sweep-skill, morning-brief, monthly-reflection) and
 * inserts corresponding rows into the briefs table.
 *
 * Modes:
 *   --dry-run  (default): prints per-skill counts of rows that would be inserted.
 *   --apply             : actually inserts rows (idempotent via ON CONFLICT DO NOTHING).
 *
 * Idempotency: uses the unique partial index on briefs.source_skill_log_id
 * (created in migration 0030) — re-running in --apply mode is safe.
 *
 * Graceful degradation per row:
 *   1. Parse result JSONB and attempt to render structured markdown via
 *      renderBriefHtml().
 *   2. If result is missing or malformed, fall back to wrapping output_summary
 *      in basic HTML.
 *   3. If both are empty, use a minimal placeholder HTML.
 *   4. Log errors and skip rather than aborting the entire run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm tsx scripts/backfill-briefs.ts
 *   DATABASE_URL=postgres://... pnpm tsx scripts/backfill-briefs.ts --dry-run
 *   DATABASE_URL=postgres://... pnpm tsx scripts/backfill-briefs.ts --apply
 *
 * Environment:
 *   DATABASE_URL  — Postgres connection string (required)
 *   PGURL         — Fallback alias for DATABASE_URL (matches benchmark-search.mjs)
 */

import { inArray, sql } from 'drizzle-orm'
import { createDb } from '../packages/shared/src/db/client.js'
import { skills_log } from '../packages/shared/src/schema/supporting.js'
import { briefs } from '../packages/shared/src/schema/briefs.js'
import {
  SKILL_TO_BRIEF_KIND,
  SKILL_TO_BRIEF_COVER,
  REFINE_OPTIONS,
} from '../packages/shared/src/types/brief.js'
import { renderBriefHtml } from '../packages/shared/src/lib/brief-renderer.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRIEF_SKILLS = ['weekly-brief', 'daily-sweep-skill', 'morning-brief', 'monthly-reflection'] as const
type BriefSkillName = (typeof BRIEF_SKILLS)[number]

// ---------------------------------------------------------------------------
// Helpers: title + subtitle + markdown from result JSONB
// ---------------------------------------------------------------------------

/**
 * Extracts a human-readable title from a skills_log row's result JSONB.
 * Falls back to a generic title with the skill name and ISO date.
 */
function extractTitle(skillName: BriefSkillName, result: unknown, createdAt: Date): string {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>

    // weekly-brief: result.brief.headline / result.title / result.briefTitle
    if (skillName === 'weekly-brief') {
      const brief = r['brief'] as Record<string, unknown> | undefined
      const weekStart = r['weekStart'] ?? r['week_start']
      const weekEnd = r['weekEnd'] ?? r['week_end']
      if (typeof weekStart === 'string' && typeof weekEnd === 'string') {
        return `Weekly Brief — ${weekStart} to ${weekEnd}`
      }
    }

    // daily-sweep-skill, morning-brief: check common title fields
    if (typeof r['title'] === 'string' && r['title']) return r['title']
    if (typeof r['briefTitle'] === 'string' && r['briefTitle']) return r['briefTitle']
    if (typeof r['brief_title'] === 'string' && r['brief_title']) return r['brief_title']

    // nested .brief.title
    if (r['brief'] && typeof r['brief'] === 'object') {
      const b = r['brief'] as Record<string, unknown>
      if (typeof b['title'] === 'string' && b['title']) return b['title']
    }
  }

  // Generic fallback: "Weekly Brief — 2026-01-15"
  const dateStr = createdAt.toISOString().slice(0, 10)
  const kindLabel: Record<BriefSkillName, string> = {
    'weekly-brief': 'Weekly Brief',
    'daily-sweep-skill': 'Daily Sweep',
    'morning-brief': 'Morning Brief',
    'monthly-reflection': 'Monthly Reflection',
  }
  return `${kindLabel[skillName]} — ${dateStr}`
}

/**
 * Extracts an optional subtitle from result JSONB.
 * For weekly-brief this is result.brief.headline.
 */
function extractSubtitle(skillName: BriefSkillName, result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>

  if (skillName === 'weekly-brief') {
    const brief = r['brief'] as Record<string, unknown> | undefined
    if (brief && typeof brief['headline'] === 'string' && brief['headline']) {
      return brief['headline']
    }
  }

  // Generic: check top-level headline / subtitle
  if (typeof r['headline'] === 'string' && r['headline']) return r['headline']
  if (typeof r['subtitle'] === 'string' && r['subtitle']) return r['subtitle']

  return undefined
}

/**
 * Attempts to build Markdown from the result JSONB.
 *
 * For weekly-brief: reconstructs sections from brief.wins, brief.blockers, etc.
 * For daily-sweep-skill: looks for result.summary or result.brief fields.
 * For morning-brief: looks for result.markdown or result.body fields.
 * For monthly-reflection: similar exploration.
 *
 * Returns null when no structured markdown can be derived — caller falls
 * back to wrapping output_summary.
 */
function buildMarkdownFromResult(skillName: BriefSkillName, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>

  // If result already contains pre-rendered markdown or body text
  for (const key of ['markdown', 'body', 'body_markdown', 'content']) {
    if (typeof r[key] === 'string' && (r[key] as string).trim()) {
      return r[key] as string
    }
  }

  // weekly-brief: reconstruct from structured output fields
  if (skillName === 'weekly-brief') {
    const brief = r['brief'] as Record<string, unknown> | undefined
    if (brief && typeof brief === 'object') {
      return buildWeeklyBriefMarkdown(brief)
    }
  }

  // daily-sweep-skill, morning-brief, monthly-reflection:
  // check for a nested .brief or .summary object with text
  for (const key of ['brief', 'summary', 'output']) {
    const nested = r[key]
    if (typeof nested === 'string' && nested.trim()) return nested
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>
      for (const subKey of ['markdown', 'body', 'text', 'content', 'summary']) {
        if (typeof n[subKey] === 'string' && (n[subKey] as string).trim()) {
          return n[subKey] as string
        }
      }
    }
  }

  return null
}

/** Reconstructs weekly-brief Markdown from the structured output object. */
function buildWeeklyBriefMarkdown(brief: Record<string, unknown>): string {
  const lines: string[] = []

  const headline = typeof brief['headline'] === 'string' ? brief['headline'] : ''
  if (headline) {
    lines.push(`## ${headline}`, '')
  }

  const sections: Array<{ key: string; heading: string }> = [
    { key: 'wins', heading: 'Wins' },
    { key: 'blockers', heading: 'Blockers' },
    { key: 'risks', heading: 'Risks' },
    { key: 'open_loops', heading: 'Open Loops' },
    { key: 'next_week_focus', heading: 'Next Week Focus' },
    { key: 'avoided_decisions', heading: 'Avoided Decisions' },
    { key: 'drift_alerts', heading: 'Drift Alerts' },
    { key: 'connections', heading: 'Connections' },
  ]

  for (const { key, heading } of sections) {
    const items = brief[key]
    if (Array.isArray(items) && items.length > 0) {
      lines.push(`### ${heading}`, '')
      for (const item of items) {
        if (typeof item === 'string' && item.trim()) {
          lines.push(`- ${item}`)
        }
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

/**
 * Wraps plain text in basic HTML paragraphs.
 * Used when no markdown source is available.
 */
function wrapTextAsHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // Split on double newlines → paragraphs; single newlines → <br>
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RowStats {
  total: number
  wouldInsert: number
  alreadyInserted: number
  errors: number
}

async function main(): Promise<void> {
  const isDryRun = !process.argv.includes('--apply')
  const mode = isDryRun ? 'DRY-RUN' : 'APPLY'

  const connectionString =
    process.env.DATABASE_URL ??
    process.env.PGURL ??
    'postgres://openbrain:openbrain@localhost:5432/openbrain'

  console.log(`[backfill-briefs] mode=${mode}`)
  console.log(`[backfill-briefs] connecting to Postgres…`)

  const { db, pool } = createDb(connectionString)

  try {
    // ------------------------------------------------------------------
    // 1. Fetch all relevant skills_log rows, ordered oldest-first so
    //    generated_at in briefs reflects the original skill run time.
    // ------------------------------------------------------------------
    const rows = await db
      .select({
        id: skills_log.id,
        skill_name: skills_log.skill_name,
        result: skills_log.result,
        output_summary: skills_log.output_summary,
        created_at: skills_log.created_at,
      })
      .from(skills_log)
      .where(inArray(skills_log.skill_name, [...BRIEF_SKILLS]))
      .orderBy(skills_log.created_at)

    console.log(`[backfill-briefs] found ${rows.length} skills_log row(s) across ${BRIEF_SKILLS.length} skills`)

    // ------------------------------------------------------------------
    // 2. Find which skill_log_ids already have a briefs row (idempotency).
    // ------------------------------------------------------------------
    const existingIds = new Set<string>()
    if (rows.length > 0) {
      const existing = await db
        .select({ source_skill_log_id: briefs.source_skill_log_id })
        .from(briefs)
        .where(
          sql`${briefs.source_skill_log_id} IN (${sql.join(
            rows.map((r) => sql`${r.id}::uuid`),
            sql`, `,
          )})`,
        )
      for (const row of existing) {
        if (row.source_skill_log_id) existingIds.add(row.source_skill_log_id)
      }
    }

    console.log(`[backfill-briefs] ${existingIds.size} row(s) already have briefs (will skip)`)

    // ------------------------------------------------------------------
    // 3. Per-skill tallies for dry-run summary
    // ------------------------------------------------------------------
    const stats: Record<string, RowStats> = {}
    for (const skill of BRIEF_SKILLS) {
      stats[skill] = { total: 0, wouldInsert: 0, alreadyInserted: 0, errors: 0 }
    }

    let insertedCount = 0

    for (const row of rows) {
      const skillName = row.skill_name as BriefSkillName
      const stat = stats[skillName]!
      stat.total++

      // Already has a briefs row — skip
      if (existingIds.has(row.id)) {
        stat.alreadyInserted++
        continue
      }

      // Build the brief fields from the skills_log row
      let briefHtml: string
      let toc: unknown[] = []

      try {
        const markdown = buildMarkdownFromResult(skillName, row.result)

        if (markdown && markdown.trim()) {
          const rendered = renderBriefHtml(markdown)
          briefHtml = rendered.html
          toc = rendered.toc as unknown[]
        } else if (row.output_summary && row.output_summary.trim()) {
          // Fallback: wrap output_summary in HTML paragraphs
          briefHtml = wrapTextAsHtml(row.output_summary)
          toc = []
        } else {
          // Last resort: minimal placeholder
          briefHtml = `<p><em>No content available for this brief.</em></p>`
          toc = []
        }

        const kind = SKILL_TO_BRIEF_KIND[skillName]
        const cover = SKILL_TO_BRIEF_COVER[skillName]

        if (!kind || !cover) {
          console.error(`[backfill-briefs] SKIP ${row.id}: unknown skill "${skillName}" not in SKILL_TO_BRIEF_KIND/COVER`)
          stat.errors++
          continue
        }

        const title = extractTitle(skillName, row.result, row.created_at!)
        const subtitle = extractSubtitle(skillName, row.result)

        stat.wouldInsert++

        if (!isDryRun) {
          await db
            .insert(briefs)
            .values({
              kind,
              cover,
              title,
              subtitle: subtitle ?? null,
              body_html: briefHtml,
              toc: toc as Record<string, unknown>[],
              sources: [] as Record<string, unknown>[],
              refine_options: [...REFINE_OPTIONS] as string[],
              source_skill_log_id: row.id,
              // Set generated_at to the original skill run time for correct ordering
              generated_at: row.created_at ?? new Date(),
            })
            .onConflictDoNothing()

          insertedCount++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[backfill-briefs] ERROR row=${row.id} skill=${skillName}: ${msg}`)
        stat.errors++
        // Continue to next row — never abort the full run on a single row failure
      }
    }

    // ------------------------------------------------------------------
    // 4. Summary report
    // ------------------------------------------------------------------
    console.log('')
    console.log(`=== Backfill Summary (${mode}) ===`)
    console.log(
      'Skill'.padEnd(24) +
        'Total'.padEnd(8) +
        'Skip(exist)'.padEnd(13) +
        'ToInsert'.padEnd(10) +
        'Errors',
    )
    console.log('-'.repeat(65))

    for (const skill of BRIEF_SKILLS) {
      const s = stats[skill]!
      console.log(
        skill.padEnd(24) +
          String(s.total).padEnd(8) +
          String(s.alreadyInserted).padEnd(13) +
          String(s.wouldInsert).padEnd(10) +
          String(s.errors),
      )
    }

    console.log('')

    if (isDryRun) {
      const totalWouldInsert = Object.values(stats).reduce((sum, s) => sum + s.wouldInsert, 0)
      console.log(`DRY-RUN complete. ${totalWouldInsert} row(s) would be inserted.`)
      console.log(`Re-run with --apply to write to the database.`)
    } else {
      console.log(`APPLY complete. ${insertedCount} row(s) inserted into briefs table.`)
    }
  } finally {
    await pool.end()
  }
}

// Run if executed directly (not imported)
const isMainModule = process.argv[1]?.replace(/\\/g, '/').includes('backfill-briefs')
if (isMainModule) {
  main().catch((err) => {
    console.error('[backfill-briefs] fatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
