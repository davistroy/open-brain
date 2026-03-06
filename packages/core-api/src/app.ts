import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { cors } from 'hono/cors'
import type { ConnectionOptions, Queue } from 'bullmq'
import type { ConfigService, Database } from '@open-brain/shared'
import { errorHandler } from './middleware/error-handler.js'
import { registerHealthRoutes } from './routes/health.js'
import { createAdminRouter } from './routes/admin.js'
import { registerCaptureRoutes } from './routes/captures.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerSkillRoutes } from './routes/skills.js'
import { registerTriggerRoutes } from './routes/triggers.js'
import { mountMcpServer } from './mcp/server.js'
import type { CaptureService } from './services/capture.js'
import type { SearchService } from './services/search.js'
import type { PipelineService } from './services/pipeline.js'
import type { TriggerService } from './services/trigger.js'

interface AppDependencies {
  configService?: ConfigService
  captureService?: CaptureService
  searchService?: SearchService
  pipelineService?: PipelineService
  /** Database instance — required for MCP entity tools */
  db?: Database
  /** Redis connection for Bull Board queue monitoring */
  redisConnection?: ConnectionOptions
  /** Skill execution queue -- required for skills API trigger endpoint */
  skillQueue?: Queue
  /** Trigger service — required for semantic trigger CRUD + test endpoints */
  triggerService?: TriggerService
}

export function createApp(deps: AppDependencies = {}): Hono {
  const app = new Hono()
  const { configService, captureService, searchService, pipelineService, db, redisConnection, skillQueue, triggerService } = deps

  // Global middleware
  app.use('*', honoLogger())
  app.use('*', cors({ origin: '*' }))
  app.onError(errorHandler())

  // Routes
  registerHealthRoutes(app)

  if (configService) {
    const adminRouter = createAdminRouter({ configService, redisConnection })
    app.route('/api/v1/admin', adminRouter)
  }

  if (captureService && configService) {
    registerCaptureRoutes(app, captureService, configService, pipelineService)
    registerStatsRoutes(app, captureService)
  }

  if (searchService) {
    registerSearchRoutes(app, searchService)
  }

  // Skills API
  if (db && skillQueue) {
    registerSkillRoutes(app, db, skillQueue)
  }

  // Triggers API
  if (triggerService) {
    registerTriggerRoutes(app, triggerService)
  }

  // MCP endpoint — requires all services to be available
  if (captureService && searchService && configService && db) {
    mountMcpServer(app, { captureService, searchService, configService, db })
  }

  return app
}
