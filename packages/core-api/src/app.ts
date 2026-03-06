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
import { registerEntityRoutes } from './routes/entities.js'
import { registerBetRoutes } from './routes/bets.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { mountMcpServer } from './mcp/server.js'
import type { CaptureService } from './services/capture.js'
import type { SearchService } from './services/search.js'
import type { PipelineService } from './services/pipeline.js'
import type { TriggerService } from './services/trigger.js'
import type { EntityService } from './services/entity.js'
import type { BetService } from './services/bet.js'
import type { SessionService } from './services/session.js'
import type { GovernanceEngine } from './services/governance-engine.js'

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
  /** Entity service — required for entity CRUD + merge/split endpoints */
  entityService?: EntityService
  /** Bet service — required for bet tracking CRUD + resolution endpoints */
  betService?: BetService
  /** Session service — required for governance session lifecycle endpoints */
  sessionService?: SessionService
  /** Governance engine — injected into SessionService to drive LLM conversation */
  governanceEngine?: GovernanceEngine
}

export function createApp(deps: AppDependencies = {}): Hono {
  const app = new Hono()
  const { configService, captureService, searchService, pipelineService, db, redisConnection, skillQueue, triggerService, entityService, betService, sessionService, governanceEngine } = deps

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

  // Entities API
  if (entityService) {
    registerEntityRoutes(app, entityService)
  }

  // Bets API
  if (betService) {
    registerBetRoutes(app, betService)
  }

  // Sessions API — inject GovernanceEngine if both are provided
  if (sessionService) {
    if (governanceEngine) {
      // Wire the engine into the session service via the optional dependency slot
      // SessionService accepts governanceEngine as its third constructor arg; since the
      // service is already constructed here we attach it via the internal property.
      // The duck-typed interface is: { processResponse(session, transcript, userMessage) }
      ;(sessionService as any).governanceEngine = governanceEngine
    }
    registerSessionRoutes(app, sessionService)
  }

  // MCP endpoint — requires all services to be available
  if (captureService && searchService && configService && db) {
    mountMcpServer(app, { captureService, searchService, configService, db, entityService })
  }

  return app
}
