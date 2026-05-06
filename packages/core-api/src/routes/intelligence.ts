import type { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Queue } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { IntelligenceService, INTELLIGENCE_SKILLS } from '../services/intelligence.service.js'

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
 * GET  /api/v1/intelligence/unresolved-questions     — unanswered question captures
 */
export function registerIntelligenceRoutes(
  app: Hono,
  db: Database,
  skillQueue: Queue<SkillExecutionJobData>,
): void {
  const intelligenceService = new IntelligenceService(db)

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/summary
  // Returns the latest result for both daily-connections and drift-monitor
  // in a single request — optimized for the Intelligence tab's initial load.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/summary', async (c) => {
    const summary = await intelligenceService.getSummary()
    return c.json(summary)
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/connections/latest
  // Returns the most recent daily-connections skill result.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/connections/latest', async (c) => {
    const data = await intelligenceService.getLatest('daily-connections')
    return c.json({ data })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/connections/history?limit=N
  // Returns recent daily-connections run history.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/connections/history', async (c) => {
    const limitParam = c.req.query('limit')
    const limit = Math.min(parseInt(limitParam ?? '10', 10) || 10, 50)
    const data = await intelligenceService.getHistory('daily-connections', limit)
    return c.json({ data })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/drift/latest
  // Returns the most recent drift-monitor skill result.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/drift/latest', async (c) => {
    const data = await intelligenceService.getLatest('drift-monitor')
    return c.json({ data })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/drift/history?limit=N
  // Returns recent drift-monitor run history.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/drift/history', async (c) => {
    const limitParam = c.req.query('limit')
    const limit = Math.min(parseInt(limitParam ?? '10', 10) || 10, 50)
    const data = await intelligenceService.getHistory('drift-monitor', limit)
    return c.json({ data })
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/intelligence/:skill/trigger
  // Manually trigger an intelligence skill (daily-connections or drift-monitor).
  // Returns 202 Accepted — the skill runs asynchronously via BullMQ.
  //
  // NOTE (A112): The trigger endpoint uses INTELLIGENCE_SKILLS from the
  // service as its validation set. The allowed trigger skills are a superset
  // of the read-skill allowlist — both sets are defined in intelligence.service.ts.
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
      'daily-sweep-skill': new Set(['tokenBudget', 'modelAlias']),
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

  // -----------------------------------------------------------------------
  // GET /api/v1/intelligence/unresolved-questions
  // Returns questions (capture_type = 'question') that have not been
  // followed up via entity overlap within 7 days.
  // -----------------------------------------------------------------------
  app.get('/api/v1/intelligence/unresolved-questions', async (c) => {
    const windowDays = Math.max(1, Math.min(Number(c.req.query('window_days') ?? '30') || 30, 365))
    const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? '20') || 20), 50)

    const windowDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

    const rows = await db.execute(sql`
      SELECT c.id::text, c.content, c.brain_view, c.created_at::text, c.tags
      FROM captures c
      WHERE c.capture_type = 'question'
        AND c.pipeline_status = 'complete'
        AND c.deleted_at IS NULL
        AND c.created_at >= ${windowDate.toISOString()}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM entity_links el1
          JOIN entity_links el2 ON el1.entity_id = el2.entity_id
          JOIN captures c2 ON el2.capture_id = c2.id
          WHERE el1.capture_id = c.id
            AND c2.id != c.id
            AND c2.created_at > c.created_at
            AND c2.created_at <= c.created_at + INTERVAL '7 days'
            AND c2.deleted_at IS NULL
            AND c2.pipeline_status = 'complete'
        )
      ORDER BY c.created_at DESC
      LIMIT ${limit}
    `)

    return c.json({ questions: rows.rows, count: rows.rows.length })
  })
}
