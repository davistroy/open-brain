import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { cors } from 'hono/cors'
import type { ConfigService } from '@open-brain/shared'
import { errorHandler } from './middleware/error-handler.js'
import { registerHealthRoutes } from './routes/health.js'
import { createAdminRouter } from './routes/admin.js'
import { registerCaptureRoutes } from './routes/captures.js'
import { registerStatsRoutes } from './routes/stats.js'
import type { CaptureService } from './services/capture.js'

interface AppDependencies {
  configService?: ConfigService
  captureService?: CaptureService
}

export function createApp(deps: AppDependencies = {}): Hono {
  const app = new Hono()
  const { configService, captureService } = deps

  // Global middleware
  app.use('*', honoLogger())
  app.use('*', cors({ origin: '*' }))
  app.onError(errorHandler())

  // Routes
  registerHealthRoutes(app)

  if (configService) {
    const adminRouter = createAdminRouter(configService)
    app.route('/api/v1/admin', adminRouter)
  }

  if (captureService && configService) {
    registerCaptureRoutes(app, captureService, configService)
    registerStatsRoutes(app, captureService)
  }

  return app
}
