import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { HonoAdapter } from '@bull-board/hono'
import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { ConfigService } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

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
export function createAdminRouter({ configService, redisConnection }: AdminRouterOptions): Hono {
  const router = new Hono()

  // POST /config/reload — hot-reload YAML config files
  router.post('/config/reload', async (c) => {
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
  } else {
    // Placeholder until Redis connection is wired at startup
    router.get('/queues', (c) => {
      return c.json({
        message: 'Bull Board requires a Redis connection — pass redisConnection to createAdminRouter()',
        queues: QUEUE_NAMES,
      })
    })
  }

  return router
}
