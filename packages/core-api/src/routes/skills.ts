import type { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Queue } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

/**
 * A row from the skills_log table (only the columns we query here).
 */
interface SkillsLogRow {
  id: string
  skill_name: string
  input_summary: string | null
  output_summary: string | null
  duration_ms: number | null
  created_at: Date | string
}

/** Job data shape for skill-execution queue */
interface SkillExecutionJobData {
  skillName: string
  captureId?: string
  sessionId?: string
  input: Record<string, unknown>
}

/**
 * Known skills with their cron schedules and descriptions.
 * Mirrors config/skills.yaml. Will be replaced by config-driven lookup
 * once skills.yaml is loaded via ConfigService (Phase 11+).
 */
const KNOWN_SKILLS: Record<string, { schedule: string; description: string }> = {
  'weekly-brief': {
    schedule: '0 20 * * 0', // Sunday 8pm
    description: 'Generate a weekly synthesis of all captures and deliver via email + Pushover',
  },
  'drift-monitor': {
    schedule: '0 9 * * 1', // Monday 9am
    description: 'Detect topic drift and attention gaps across brain views',
  },
  'daily-connections': {
    schedule: '0 18 * * *', // Daily 6pm
    description: 'Surface non-obvious connections between recent captures',
  },
  'pipeline-health': {
    schedule: '0 * * * *', // Every hour
    description: 'Check BullMQ queue stats and recent pipeline failures; alert via Pushover if thresholds exceeded',
  },
}

/**
 * Register skills management API routes.
 *
 * GET  /api/v1/skills                  — list configured skills with schedules and last run status
 * POST /api/v1/skills/:name/trigger    — manually trigger a skill execution
 */
export function registerSkillRoutes(
  app: Hono,
  db: Database,
  skillQueue: Queue<SkillExecutionJobData>,
): void {
  // -----------------------------------------------------------------------
  // GET /api/v1/skills
  // Returns each skill name, its cron schedule (from config), and the most
  // recent skills_log entry (last_run_at, last_duration_ms, last_output_summary).
  // -----------------------------------------------------------------------
  app.get('/api/v1/skills', async (c) => {
    // Pull the most recent skills_log row per skill_name so we can surface
    // last-run metadata without requiring the skills.yaml config at runtime.
    const rows = await db.execute<SkillsLogRow>(sql`
      SELECT DISTINCT ON (skill_name)
        id,
        skill_name,
        input_summary,
        output_summary,
        duration_ms,
        created_at
      FROM skills_log
      ORDER BY skill_name, created_at DESC
    `)

    // Build a map of skill_name → last log entry for O(1) lookup
    const lastRunBySkill = new Map<string, SkillsLogRow>()
    for (const row of rows.rows as SkillsLogRow[]) {
      if (!lastRunBySkill.has(row.skill_name)) {
        lastRunBySkill.set(row.skill_name, row)
      }
    }

    // Merge known skills with any that appear in the log but aren't in KNOWN_SKILLS
    const allSkillNames = new Set([
      ...Object.keys(KNOWN_SKILLS),
      ...(rows.rows as SkillsLogRow[]).map((r) => r.skill_name),
    ])

    const skills = Array.from(allSkillNames).map((name) => {
      const config = KNOWN_SKILLS[name]
      const lastRun = lastRunBySkill.get(name)

      return {
        name,
        schedule: config?.schedule ?? null,
        description: config?.description ?? null,
        last_run_at: lastRun?.created_at ?? null,
        last_duration_ms: lastRun?.duration_ms ?? null,
        last_output_summary: lastRun?.output_summary ?? null,
        last_input_summary: lastRun?.input_summary ?? null,
      }
    })

    return c.json({ skills })
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/skills/:name/trigger
  // Enqueues a skill execution job. Returns 202 Accepted immediately —
  // the skill runs asynchronously in the workers process.
  // -----------------------------------------------------------------------
  app.post('/api/v1/skills/:name/trigger', async (c) => {
    const name = c.req.param('name')

    // Validate that the skill name is non-empty and alphanumeric/hyphen only
    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      return c.json({ error: 'Invalid skill name', code: 'VALIDATION_ERROR' }, 400)
    }

    // Parse optional body for override options (e.g., windowDays for weekly-brief)
    let overrides: Record<string, unknown> = {}
    try {
      const body = await c.req.json().catch(() => null)
      if (body && typeof body === 'object') {
        overrides = body as Record<string, unknown>
      }
    } catch {
      // Body is optional — ignore parse errors
    }

    logger.info({ skillName: name, overrides }, '[skills-api] manual trigger received')

    const job = await skillQueue.add(
      name,
      {
        skillName: name,
        input: overrides,
      },
      {
        // Manual triggers run at slightly higher priority than scheduled runs
        priority: 2,
        jobId: `manual:${name}:${Date.now()}`,
      },
    )

    logger.info({ skillName: name, jobId: job.id }, '[skills-api] skill execution enqueued')

    return c.json(
      {
        skill: name,
        job_id: job.id,
        status: 'queued',
        message: `Skill '${name}' has been queued for execution`,
      },
      202,
    )
  })
}
