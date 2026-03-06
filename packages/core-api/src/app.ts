import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { cors } from 'hono/cors'
import { ConfigService } from '@open-brain/shared'
import { errorHandler } from './middleware/error-handler.js'
import { registerHealthRoutes } from './routes/health.js'
import { createAdminRouter } from './routes/admin.js'

export function createApp(configService?: ConfigService): Hono {
  const app = new Hono()

  // Global middleware
  app.use('*', honoLogger())
  app.use('*', cors({ origin: '*' }))
  app.use('*', errorHandler())

  // Routes
  registerHealthRoutes(app)

  if (configService) {
    const adminRouter = createAdminRouter(configService)
    app.route('/api/v1/admin', adminRouter)
  }

  return app
}
