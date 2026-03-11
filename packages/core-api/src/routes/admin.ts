import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { HonoAdapter } from '@bull-board/hono'
import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { sql } from 'drizzle-orm'
import type { ConfigService, Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'
import { adminAuth } from '../middleware/admin-auth.js'

/**
 * Queue names that Bull Board registers for monitoring.
 * Must match the queue names defined in @open-brain/workers queues/*.
 */
const QUEUE_NAMES = [
  'capture-pipeline',
  'skill-execution',
  'notification',
  'access-stats',
  'daily-sweep',
] as const

export interface AdminRouterOptions {
  configService: ConfigService
  /** Redis connection for Bull Board queue monitoring. Optional — if omitted, /queues returns a placeholder. */
  redisConnection?: ConnectionOptions
  /** Database instance — required for POST /reset-data */
  db?: Database
}

/**
 * Creates the admin router.
 *
 * Mounts:
 *   POST /config/reload  — hot-reload YAML config files
 *   GET  /queues/*       — Bull Board UI (when redisConnection is provided)
 *
 * Bull Board path: /api/v1/admin/queues
 * (app.ts mounts this router at /api/v1/admin)
 */
export function createAdminRouter({ configService, redisConnection, db }: AdminRouterOptions): Hono {
  const router = new Hono()

  // POST /config/reload — hot-reload YAML config files (auth required)
  router.post('/config/reload', adminAuth(), async (c) => {
    logger.info('Config reload requested via admin API')
    const results = configService.reload()
    const allSuccess = results.every(r => r.success)
    logger.info({ results }, 'Config reload complete')
    return c.json({
      success: allSuccess,
      results,
      reloaded_at: new Date().toISOString(),
    }, allSuccess ? 200 : 207)
  })

  // POST /reset-data — truncate all user data tables, preserve schema + migration history
  // Requires body: { confirm: "WIPE ALL DATA" }
  // Preserves: triggers (user config), schema, __drizzle_migrations
  // Auth required — destructive endpoint
  router.post('/reset-data', adminAuth(), async (c) => {
    if (!db) {
      return c.json({ error: 'Database not configured for reset endpoint' }, 503)
    }

    let body: Record<string, unknown> | null = null
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON with { "confirm": "WIPE ALL DATA" }' }, 400)
    }

    if (!body || body.confirm !== 'WIPE ALL DATA') {
      return c.json(
        { error: 'Confirmation required. Send { "confirm": "WIPE ALL DATA" } in the request body.' },
        400,
      )
    }

    logger.warn('[admin] Data reset initiated — wiping all user data')

    // Tables ordered to avoid FK constraint errors; CASCADE handles any remainder.
    // Triggers are intentionally preserved (user configuration, not test data).
    // __drizzle_migrations is a system table and is never touched.
    await db.execute(sql`
      TRUNCATE
        skills_log,
        ai_audit_log,
        session_messages,
        bets,
        sessions,
        entity_links,
        entity_relationships,
        entities,
        pipeline_events,
        captures
      CASCADE
    `)

    const clearedTables = [
      'captures', 'pipeline_events', 'entities', 'entity_links',
      'entity_relationships', 'sessions', 'session_messages',
      'bets', 'skills_log', 'ai_audit_log',
    ]

    logger.warn({ clearedTables }, '[admin] Data reset complete')

    return c.json({
      cleared: clearedTables,
      preserved: ['triggers', '__drizzle_migrations', 'schema'],
      wiped_at: new Date().toISOString(),
    })
  })

  if (redisConnection) {
    // Create read-only Queue instances for Bull Board — no workers attached.
    // These are lightweight: no polling, no processing, just queue inspection.
    const queues = QUEUE_NAMES.map(
      (name) => new Queue(name, { connection: redisConnection }),
    )

    const serverAdapter = new HonoAdapter(serveStatic)

    createBullBoard({
      queues: queues.map((q) => new BullMQAdapter(q)),
      serverAdapter,
    })

    // Bull Board base path must match where it's mounted in the final app.
    // app.ts mounts this router at /api/v1/admin, so the full path is /api/v1/admin/queues.
    serverAdapter.setBasePath('/api/v1/admin/queues')

    const bullBoardApp = serverAdapter.registerPlugin()
    router.route('/queues', bullBoardApp)

    logger.info('[admin] Bull Board mounted at /api/v1/admin/queues')

    // GET /pipeline/health — returns BullMQ queue counts in PipelineStatus format
    router.get('/pipeline/health', async (ctx) => {
      type QueueCounts = { waiting: number; active: number; completed: number; failed: number; delayed: number }
      const counts: Array<{ name: string } & QueueCounts> = await Promise.all(
        queues.map(async (q) => {
          const result = await q.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed') as QueueCounts
          return { name: q.name, ...result }
        }),
      )

      const queueMap: Record<string, QueueCounts> = {}
      let totalPending = 0
      let totalProcessing = 0
      let totalComplete = 0
      let totalFailed = 0

      for (const q of counts) {
        queueMap[q.name] = {
          waiting: q.waiting ?? 0,
          active: q.active ?? 0,
          completed: q.completed ?? 0,
          failed: q.failed ?? 0,
          delayed: q.delayed ?? 0,
        }
        totalPending += (q.waiting ?? 0) + (q.delayed ?? 0)
        totalProcessing += q.active ?? 0
        totalComplete += q.completed ?? 0
        totalFailed += q.failed ?? 0
      }

      return ctx.json({
        queues: queueMap,
        overall: {
          pending: totalPending,
          processing: totalProcessing,
          complete: totalComplete,
          failed: totalFailed,
        },
      })
    })
  } else {
    // Placeholder until Redis connection is wired at startup
    router.get('/queues', (c) => {
      return c.json({
        message: 'Bull Board requires a Redis connection — pass redisConnection to createAdminRouter()',
        queues: QUEUE_NAMES,
      })
    })

    router.get('/pipeline/health', (c) => {
      return c.json({
        message: 'Pipeline health requires a Redis connection',
        queues: {},
        overall: { pending: 0, processing: 0, complete: 0, failed: 0 },
      })
    })
  }

  return router
}
