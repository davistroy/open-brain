import { Hono } from 'hono'
import { ConfigService } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

export function createAdminRouter(configService: ConfigService): Hono {
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

  // GET /queues — placeholder for Bull Board (wired in Phase 6)
  router.get('/queues', (c) => {
    return c.json({
      message: 'Bull Board will be available here in Phase 6',
      queues: [],
    })
  })

  return router
}
