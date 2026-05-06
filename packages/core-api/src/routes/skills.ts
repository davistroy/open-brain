import type { Hono } from 'hono'
import type { Queue } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { NotFoundError, ValidationError, logger } from '@open-brain/shared'
import {
  getSkillConfigSingleton,
  type SkillConfig,
} from '../services/skill-config.js'
import { getLatestRunPerSkill, getLogsForSkill } from '../services/skill-log.js'
import type { SkillsLogRow } from '../services/skill-log.js'

// Re-export everything tests and index.ts import from this module
export {
  type SkillConfig,
  loadSkillsFromYaml,
  setSkillsYamlPath,
  getKnownSkills,
  resetKnownSkills,
  validateCronExpression,
} from '../services/skill-config.js'

/** Job data shape for skill-execution queue */
interface SkillExecutionJobData {
  skillName: string
  captureId?: string
  sessionId?: string
  input: Record<string, unknown>
}

/**
 * Register skills management API routes.
 *
 * GET   /api/v1/skills                  — list configured skills with schedules and last run status
 * POST  /api/v1/skills/:name/trigger    — manually trigger a skill execution
 * GET   /api/v1/skills/:name/logs       — recent log entries for a skill
 * PATCH /api/v1/skills/:name            — update a skill's schedule
 */
export function registerSkillRoutes(
  app: Hono,
  db: Database,
  skillQueue: Queue<SkillExecutionJobData>,
): void {
  const skillConfig = getSkillConfigSingleton()

  // -----------------------------------------------------------------------
  // GET /api/v1/skills
  // -----------------------------------------------------------------------
  app.get('/api/v1/skills', async (c) => {
    const rows = await getLatestRunPerSkill(db)

    // Build a map of skill_name → last log entry for O(1) lookup
    const lastRunBySkill = new Map<string, SkillsLogRow>()
    for (const row of rows) {
      if (!lastRunBySkill.has(row.skill_name)) {
        lastRunBySkill.set(row.skill_name, row)
      }
    }

    const knownSkills = skillConfig.getAll()

    // Merge known skills with any that appear in the log but aren't configured
    const allSkillNames = new Set([
      ...Object.keys(knownSkills),
      ...rows.map((r) => r.skill_name),
    ])

    const skills = Array.from(allSkillNames).map((name) => {
      const config = knownSkills[name]
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
  // -----------------------------------------------------------------------
  app.post('/api/v1/skills/:name/trigger', async (c) => {
    const name = c.req.param('name')

    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError('Invalid skill name')
    }

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
        priority: 2,
        jobId: `manual_${name}_${Date.now()}`,
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

  // -----------------------------------------------------------------------
  // GET /api/v1/skills/:name/logs
  // -----------------------------------------------------------------------
  app.get('/api/v1/skills/:name/logs', async (c) => {
    const name = c.req.param('name')
    const limitParam = c.req.query('limit')
    const limit = Math.min(parseInt(limitParam ?? '20', 10) || 20, 100)

    const rows = await getLogsForSkill(db, name, limit)

    const data = rows.map((row) => ({
      id: row.id,
      skill_name: row.skill_name,
      capture_id: row.capture_id,
      status: 'completed',
      started_at: row.created_at,
      completed_at: row.created_at,
      duration_ms: row.duration_ms,
      output: row.output_summary,
      result: row.result ?? null,
    }))

    return c.json({ data })
  })

  // -----------------------------------------------------------------------
  // PATCH /api/v1/skills/:name
  // -----------------------------------------------------------------------
  app.patch('/api/v1/skills/:name', async (c) => {
    const name = c.req.param('name')

    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      throw new ValidationError('Invalid skill name')
    }

    if (!skillConfig.get(name)) {
      throw new NotFoundError(`Unknown skill: ${name}`)
    }

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json(
        { error: 'Invalid JSON body', code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const schedule = body.schedule
    if (schedule === undefined || typeof schedule !== 'string') {
      return c.json(
        { error: 'Missing or invalid "schedule" field — must be a cron expression string', code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const cronResult = skillConfig.validateCron(schedule)
    if (!cronResult.valid) {
      return c.json(
        { error: `Invalid cron expression: ${cronResult.error}`, code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const trimmedSchedule = schedule.trim()

    // Update in-memory config
    skillConfig.update(name, { schedule: trimmedSchedule })

    // Persist to YAML
    try {
      skillConfig.save()
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, '[skills-api] Failed to persist schedule to YAML')
    }

    logger.info({ skillName: name, schedule: trimmedSchedule }, '[skills-api] Schedule updated')

    return c.json({
      name,
      schedule: trimmedSchedule,
      updated_at: new Date().toISOString(),
    })
  })
}
