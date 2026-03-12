import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Hono } from 'hono'
import { desc, eq, sql } from 'drizzle-orm'
import type { Queue } from 'bullmq'
import { CronExpressionParser } from 'cron-parser'
import yaml from 'js-yaml'
import type { Database } from '@open-brain/shared'
import { skills_log } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

/**
 * A row from the skills_log table (only the columns we query here).
 */
type SkillsLogRow = {
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
type SkillsLogDetailRow = {
  id: string
  skill_name: string
  capture_id: string | null
  input_summary: string | null
  output_summary: string | null
  result: Record<string, unknown> | null
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

/** Shape for a skill config entry */
export interface SkillConfig {
  schedule: string
  description: string
}

/**
 * Default skills with their cron schedules and descriptions.
 * Used as baseline when config/skills.yaml doesn't exist or is incomplete.
 */
const DEFAULT_SKILLS: Record<string, SkillConfig> = {
  'weekly-brief': {
    schedule: '0 20 * * 0', // Sunday 8pm
    description: 'Generate a weekly synthesis of all captures and deliver via email + Pushover',
  },
  'daily-connections': {
    schedule: '0 21 * * *', // Daily 9pm
    description: 'Surface non-obvious cross-domain connections across recent captures via LLM synthesis and deliver via Pushover',
  },
  'drift-monitor': {
    schedule: '0 8 * * *', // Daily 8am
    description: 'Detect when tracked commitments, bets, or projects go silent and alert via Pushover if severity >= medium',
  },
  'pipeline-health': {
    schedule: '0 * * * *', // Every hour
    description: 'Check BullMQ queue stats and recent pipeline failures; alert via Pushover if thresholds exceeded',
  },
}

/**
 * Known skills — mutable record initialized from DEFAULT_SKILLS and optionally
 * overridden by config/skills.yaml at startup. Updated in-place by PATCH endpoint.
 */
let KNOWN_SKILLS: Record<string, SkillConfig> = { ...DEFAULT_SKILLS }

/** Path to the persisted skills YAML configuration file */
let skillsYamlPath = join(process.cwd(), 'config', 'skills.yaml')

/**
 * Override the skills.yaml path (used by tests to avoid writing to real config).
 */
export function setSkillsYamlPath(path: string): void {
  skillsYamlPath = path
}

/**
 * Get the current KNOWN_SKILLS record (exported for testing).
 */
export function getKnownSkills(): Record<string, SkillConfig> {
  return KNOWN_SKILLS
}

/**
 * Reset KNOWN_SKILLS to defaults (exported for testing).
 */
export function resetKnownSkills(): void {
  KNOWN_SKILLS = { ...DEFAULT_SKILLS }
}

/** YAML shape for skills.yaml */
interface SkillsYamlData {
  skills: Record<string, { schedule?: string; description?: string }>
}

/**
 * Load skill overrides from config/skills.yaml. Merges on top of DEFAULT_SKILLS.
 * If the file doesn't exist or is malformed, keeps defaults and logs a warning.
 * Called at startup before routes are registered.
 */
export function loadSkillsFromYaml(): void {
  if (!existsSync(skillsYamlPath)) {
    logger.info('[skills] No config/skills.yaml found — using hardcoded defaults')
    return
  }

  try {
    const content = readFileSync(skillsYamlPath, 'utf8')
    const data = yaml.load(content) as SkillsYamlData | null

    if (!data || typeof data !== 'object' || !data.skills || typeof data.skills !== 'object') {
      logger.warn('[skills] config/skills.yaml has unexpected shape — using defaults')
      return
    }

    // Merge persisted overrides on top of defaults
    for (const [name, overrides] of Object.entries(data.skills)) {
      const base = DEFAULT_SKILLS[name]
      if (base) {
        KNOWN_SKILLS[name] = {
          schedule: overrides.schedule ?? base.schedule,
          description: overrides.description ?? base.description,
        }
      } else {
        // Skill in YAML but not in defaults — include it if it has a schedule
        if (overrides.schedule) {
          KNOWN_SKILLS[name] = {
            schedule: overrides.schedule,
            description: overrides.description ?? '',
          }
        }
      }
    }

    logger.info({ skillCount: Object.keys(KNOWN_SKILLS).length }, '[skills] Loaded overrides from config/skills.yaml')
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, '[skills] Failed to parse config/skills.yaml — using defaults')
  }
}

/**
 * Persist the current KNOWN_SKILLS schedules to config/skills.yaml.
 * Creates the config directory if it doesn't exist.
 */
function saveSkillsToYaml(): void {
  const data: SkillsYamlData = {
    skills: {},
  }

  for (const [name, config] of Object.entries(KNOWN_SKILLS)) {
    data.skills[name] = {
      schedule: config.schedule,
      description: config.description,
    }
  }

  const dir = dirname(skillsYamlPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const yamlStr = yaml.dump(data, { lineWidth: 120, noRefs: true })
  writeFileSync(skillsYamlPath, yamlStr, 'utf8')
  logger.info('[skills] Persisted skill config to config/skills.yaml')
}

/**
 * Validate a cron expression. Must be a standard 5-field cron expression.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateCronExpression(expr: string): string | null {
  if (!expr || typeof expr !== 'string') {
    return 'Schedule must be a non-empty string'
  }

  const trimmed = expr.trim()
  const fields = trimmed.split(/\s+/)

  // BullMQ expects standard 5-field cron (minute hour day-of-month month day-of-week)
  if (fields.length !== 5) {
    return `Expected 5-field cron expression (minute hour day-of-month month day-of-week), got ${fields.length} fields`
  }

  try {
    CronExpressionParser.parse(trimmed)
    return null // valid
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression'
  }
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
  // -----------------------------------------------------------------------
  // GET /api/v1/skills
  // Returns each skill name, its cron schedule (from config), and the most
  // recent skills_log entry (last_run_at, last_duration_ms, last_output_summary).
  // -----------------------------------------------------------------------
  app.get('/api/v1/skills', async (c) => {
    // Pull the most recent skills_log row per skill_name so we can surface
    // last-run metadata without requiring the skills.yaml config at runtime.
    // DISTINCT ON isn't expressible in Drizzle query builder, so we use typed raw SQL.
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

    // Build a map of skill_name → last log entry for O(1) lookup
    const lastRunBySkill = new Map<string, SkillsLogRow>()
    for (const row of rows.rows) {
      if (!lastRunBySkill.has(row.skill_name)) {
        lastRunBySkill.set(row.skill_name, row)
      }
    }

    // Merge known skills with any that appear in the log but aren't in KNOWN_SKILLS
    const allSkillNames = new Set([
      ...Object.keys(KNOWN_SKILLS),
      ...rows.rows.map((r) => r.skill_name),
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
  // Returns the most recent skills_log entries for a given skill.
  // Used by the Briefs page to display run history.
  // -----------------------------------------------------------------------
  app.get('/api/v1/skills/:name/logs', async (c) => {
    const name = c.req.param('name')
    const limitParam = c.req.query('limit')
    const limit = Math.min(parseInt(limitParam ?? '20', 10) || 20, 100)

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

    const data = rows.rows.map((row) => ({
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
  // Update a skill's cron schedule. Validates the cron expression, updates
  // the in-memory KNOWN_SKILLS map, and persists to config/skills.yaml.
  // Note: schedule changes take effect after the next scheduler restart
  // (BullMQ repeatable jobs are not hot-reloaded in v1).
  // -----------------------------------------------------------------------
  app.patch('/api/v1/skills/:name', async (c) => {
    const name = c.req.param('name')

    // Validate skill name format
    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      return c.json({ error: 'Invalid skill name', code: 'VALIDATION_ERROR' }, 400)
    }

    // Skill must exist in KNOWN_SKILLS
    if (!KNOWN_SKILLS[name]) {
      return c.json(
        { error: 'Skill not found', code: 'NOT_FOUND', message: `Unknown skill: ${name}` },
        404,
      )
    }

    // Parse request body
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

    // Validate cron expression
    const cronError = validateCronExpression(schedule)
    if (cronError) {
      return c.json(
        { error: `Invalid cron expression: ${cronError}`, code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const trimmedSchedule = schedule.trim()

    // Update in-memory config
    KNOWN_SKILLS[name] = {
      ...KNOWN_SKILLS[name],
      schedule: trimmedSchedule,
    }

    // Persist to YAML
    try {
      saveSkillsToYaml()
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, '[skills-api] Failed to persist schedule to YAML')
      // In-memory update succeeded — don't roll back. Log the error but return success.
      // The schedule is active in-memory; it'll be re-persisted on the next write.
    }

    logger.info({ skillName: name, schedule: trimmedSchedule }, '[skills-api] Schedule updated')

    return c.json({
      name,
      schedule: trimmedSchedule,
      updated_at: new Date().toISOString(),
    })
  })
}
