import type { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Queue } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

/**
 * Shape of a skills_log row returned by intelligence queries.
 */
interface IntelligenceLogRow {
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

/** Allowed intelligence skill names — prevents arbitrary skill_name injection into SQL */
const INTELLIGENCE_SKILLS = new Set(['daily-connections', 'drift-monitor'])

/** Job data shape for skill-execution queue */
interface SkillExecutionJobData {
  skillName: string
  captureId?: string
  sessionId?: string
  input: Record<string, unknown>
}

/**
 * Register intelligence API routes.
 *
 * These endpoints provide optimized access to daily-connections and
 * drift-monitor skill results for the web dashboard's Intelligence tab.
 *
 * GET  /api/v1/intelligence/summary                 — combined latest results for both skills
 * GET  /api/v1/intelligence/connections/latest       — latest daily-connections result
 * GET  /api/v1/intelligence/connections/history      — recent daily-connections run history
 * GET  /api/v1/intelligence/drift/latest             — latest drift-monitor result
 * GET  /api/v1/intelligence/drift/history            — recent drift-monitor run history
 * POST /api/v1/intelligence/:skill/trigger           — manually trigger an intelligence skill
 */
export function registerIntelligenceRoutes(
  app: Hono,
  db: Database,
  skillQueue: Queue<SkillExecutionJobData>,
): void {
  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/summary
  // Returns the latest result for both daily-connections and drift-monitor
  // in a single request — optimized for the Intelligence tab's initial load.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/summary', async (c) => {
    const rows = await db.execute<IntelligenceLogRow>(sql`
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

    const bySkill: Record<string, IntelligenceLogRow | null> = {
      'daily-connections': null,
      'drift-monitor': null,
    }

    for (const row of rows.rows) {
      if (INTELLIGENCE_SKILLS.has(row.skill_name)) {
        bySkill[row.skill_name] = row
      }
    }

    return c.json({
      connections: bySkill['daily-connections']
        ? formatLogEntry(bySkill['daily-connections'])
        : null,
      drift: bySkill['drift-monitor']
        ? formatLogEntry(bySkill['drift-monitor'])
        : null,
    })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/connections/latest
  // Returns the most recent daily-connections skill result.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/connections/latest', async (c) => {
    const rows = await db.execute<IntelligenceLogRow>(sql`
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
      WHERE skill_name = 'daily-connections'
      ORDER BY created_at DESC
      LIMIT 1
    `)

    if (rows.rows.length === 0) {
      return c.json({ data: null })
    }

    return c.json({ data: formatLogEntry(rows.rows[0]) })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/connections/history?limit=N
  // Returns recent daily-connections run history.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/connections/history', async (c) => {
    const limitParam = c.req.query('limit')
    const limit = Math.min(parseInt(limitParam ?? '10', 10) || 10, 50)

    const rows = await db.execute<IntelligenceLogRow>(sql`
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
      WHERE skill_name = 'daily-connections'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)

    return c.json({ data: rows.rows.map(formatLogEntry) })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/drift/latest
  // Returns the most recent drift-monitor skill result.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/drift/latest', async (c) => {
    const rows = await db.execute<IntelligenceLogRow>(sql`
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
      WHERE skill_name = 'drift-monitor'
      ORDER BY created_at DESC
      LIMIT 1
    `)

    if (rows.rows.length === 0) {
      return c.json({ data: null })
    }

    return c.json({ data: formatLogEntry(rows.rows[0]) })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/drift/history?limit=N
  // Returns recent drift-monitor run history.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/drift/history', async (c) => {
    const limitParam = c.req.query('limit')
    const limit = Math.min(parseInt(limitParam ?? '10', 10) || 10, 50)

    const rows = await db.execute<IntelligenceLogRow>(sql`
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
      WHERE skill_name = 'drift-monitor'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)

    return c.json({ data: rows.rows.map(formatLogEntry) })
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/intelligence/:skill/trigger
  // Manually trigger an intelligence skill (daily-connections or drift-monitor).
  // Returns 202 Accepted — the skill runs asynchronously via BullMQ.
  // -----------------------------------------------------------------------
  app.post('/api/v1/intelligence/:skill/trigger', async (c) => {
    const skill = c.req.param('skill')

    if (!skill || !INTELLIGENCE_SKILLS.has(skill)) {
      return c.json(
        {
          error: `Unknown intelligence skill: '${skill}'. Valid skills: ${Array.from(INTELLIGENCE_SKILLS).join(', ')}`,
          code: 'VALIDATION_ERROR',
        },
        400,
      )
    }

    // Parse optional body for override options (e.g., windowDays)
    // Allowlist accepted keys per skill to prevent arbitrary data in Redis
    const ALLOWED_OVERRIDES: Record<string, Set<string>> = {
      'daily-connections': new Set(['windowDays', 'tokenBudget', 'modelAlias']),
      'drift-monitor': new Set(['betActivityDays', 'commitmentDays', 'entityWindowDays', 'modelAlias']),
      'weekly-brief': new Set(['windowDays', 'tokenBudget', 'modelAlias', 'emailTo']),
    }
    let overrides: Record<string, unknown> = {}
    try {
      const body = await c.req.json().catch(() => null)
      if (body && typeof body === 'object') {
        const allowed = ALLOWED_OVERRIDES[skill] ?? new Set<string>()
        for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
          if (allowed.has(key)) {
            overrides[key] = value
          }
        }
      }
    } catch {
      // Body is optional — ignore parse errors
    }

    logger.info({ skill, overrides }, '[intelligence-api] manual trigger received')

    const job = await skillQueue.add(
      skill,
      {
        skillName: skill,
        input: overrides,
      },
      {
        priority: 2,
        jobId: `manual_${skill}_${Date.now()}`,
      },
    )

    logger.info({ skill, jobId: job.id }, '[intelligence-api] skill execution enqueued')

    return c.json(
      {
        skill,
        job_id: job.id,
        status: 'queued',
        message: `Intelligence skill '${skill}' has been queued for execution`,
      },
      202,
    )
  })
}

/**
 * Formats a raw skills_log row into the shape expected by the web dashboard.
 */
function formatLogEntry(row: IntelligenceLogRow) {
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
