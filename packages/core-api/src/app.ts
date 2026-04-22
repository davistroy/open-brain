import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { cors } from 'hono/cors'
import type { ConnectionOptions, Queue } from 'bullmq'
import type { ConfigService, Database, IngestProcessJobData } from '@open-brain/shared'
import { errorHandler } from './middleware/error-handler.js'
import { RateLimiter, RATE_LIMIT_TIERS, rateLimit } from './middleware/rate-limit.js'
import { registerHealthRoutes } from './routes/health.js'
import { createAdminRouter } from './routes/admin.js'
import { registerCaptureRoutes } from './routes/captures.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerSkillRoutes } from './routes/skills.js'
import { registerTriggerRoutes } from './routes/triggers.js'
import { registerEntityRoutes } from './routes/entities.js'
import { registerBetRoutes } from './routes/bets.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerEventsRoutes } from './routes/events.js'
import { registerSystemHealthRoutes } from './routes/system-health.js'
import { registerDocumentRoutes } from './routes/documents.js'
import { registerSynthesizeRoutes } from './routes/synthesize.js'
import { registerIntelligenceRoutes } from './routes/intelligence.js'
import { registerWikiRoutes } from './routes/wiki.js'
import { registerActivityRoutes } from './routes/activity.js'
import { registerMcpActivityRoutes } from './routes/mcp-activity.js'
import { registerConfigRoutes } from './routes/config.js'
import { registerEmailRoutes } from './routes/email.js'
import { registerVoiceSessionRoutes } from './routes/voice-sessions.js'
import { registerMetricsRoute, metricsMiddleware } from './routes/metrics.js'
import type { MetricsRedisClient } from './routes/metrics.js'
import { registerIngestRoutes } from './routes/ingest.js'
import { registerInsurancePoliciesRoutes } from './routes/insurance-policies.js'
import { registerBriefRoutes } from './routes/briefs.js'
import type { TtsDeps } from './routes/briefs.js'
import { registerCommitmentRoutes } from './routes/commitments.js'
import { mountMcpServer } from './mcp/server.js'
import type { CaptureService } from './services/capture.js'
import type { SearchService } from './services/search.js'
import type { PipelineService } from './services/pipeline.js'
import type { TriggerService } from './services/trigger.js'
import type { EntityService } from './services/entity.js'
import type { BetService } from './services/bet.js'
import type { SessionService } from './services/session.js'
import type { LLMGatewayService } from '@open-brain/shared'
import type { SystemHealthService } from './services/system-health.js'
import type { WikiService } from './services/wiki.js'
import type { ActivityFeedService } from './services/activity-feed.js'
import type { EmailDraftService } from './services/email-draft.js'
import type { EmailComposeAssistService } from './services/email-compose-assist.js'
import type { VoiceSessionService } from './services/voice-session.js'
import type { BriefsService } from './services/briefs.js'

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
  /** Document pipeline queue — required for POST /api/v1/documents upload endpoint */
  documentPipelineQueue?: Queue
  /** LLM Gateway — required for POST /api/v1/synthesize */
  llmGateway?: LLMGatewayService
  /** System health service — required for GET /api/v1/system/health */
  systemHealthService?: SystemHealthService
  /** Wiki service — required for wiki API endpoints and MCP wiki tools */
  wikiService?: WikiService
  /** Activity feed service — required for activity feed API and SSE */
  activityFeedService?: ActivityFeedService
  /** Email draft service — required for email draft management endpoints */
  emailDraftService?: EmailDraftService
  /** Email-compose AI-assist service — optional, enables POST /api/v1/email/compose-draft */
  emailComposeAssistService?: EmailComposeAssistService
  /** Voice session service — required for voice conversation session endpoints */
  voiceSessionService?: VoiceSessionService
  /** Briefs service — required for GET/POST/PATCH /api/v1/briefs endpoints (CS2 M2) */
  briefsService?: BriefsService
  /** TTS dependencies — required for POST /api/v1/briefs/:id/audio (CS5 M3 item 4.1) */
  ttsDeps?: TtsDeps
  /** Ingest-process BullMQ queue — required for POST /api/v1/ingest/upload pipeline dispatch (CS3.4/CS3.5) */
  ingestProcessQueue?: Queue<IngestProcessJobData>
  /** Access-stats BullMQ queue — fire-and-forget after search completion (P06 Hebbian co-access) */
  accessStatsQueue?: Queue<{ captureIds: string[]; accessedAt: string }>
  /**
   * Redis client for /metrics gauge refresh (P11b).
   * Reads composio:monthly_usage:YYYY-MM on each Prometheus scrape.
   * Optional — gauges default to 0 when absent.
   */
  metricsRedis?: MetricsRedisClient
}

export function createApp(deps: AppDependencies = {}): Hono {
  const app = new Hono()
  const { configService, captureService, searchService, pipelineService, db, redisConnection, skillQueue, triggerService, entityService, betService, sessionService, documentPipelineQueue, llmGateway, systemHealthService, wikiService, activityFeedService, emailDraftService, emailComposeAssistService, voiceSessionService, ingestProcessQueue, accessStatsQueue, metricsRedis, briefsService, ttsDeps } = deps

  // Rate limiter instances (in-memory, no persistence needed for single-user)
  const defaultLimiter = new RateLimiter(RATE_LIMIT_TIERS.default)
  const strictLimiter = new RateLimiter(RATE_LIMIT_TIERS.strict)
  const adminLimiter = new RateLimiter(RATE_LIMIT_TIERS.admin)

  // Global middleware
  app.use('*', honoLogger())
  app.use('*', cors({ origin: ['https://brain.k4jda.net', 'https://brain.troy-davis.com', 'http://localhost:5173', 'http://localhost:3000'] }))
  app.use('*', metricsMiddleware())
  app.onError(errorHandler())

  // Rate limiting — tiered by endpoint group
  // Strict tier: endpoints that trigger LLM/embedding calls
  app.use('/api/v1/captures', rateLimit(strictLimiter))
  app.use('/api/v1/captures/*', rateLimit(strictLimiter))
  app.use('/api/v1/search', rateLimit(strictLimiter))
  app.use('/api/v1/synthesize', rateLimit(strictLimiter))
  // Briefs refine triggers an LLM skill — strict rate-limit BEFORE default /api/v1/* mount
  // (Hono first-match wins; must precede the default-tier wildcard below)
  app.use('/api/v1/briefs/*/refine', rateLimit(strictLimiter))
  // Briefs audio calls OpenAI TTS API — strict rate-limit BEFORE default /api/v1/* mount
  app.use('/api/v1/briefs/*/audio', rateLimit(strictLimiter))
  // Entity ask triggers LLM synthesis — strict rate-limit BEFORE default /api/v1/* mount
  // (Hono first-match wins; must precede the default-tier wildcard below)
  app.use('/api/v1/entities/*/ask', rateLimit(strictLimiter))
  // Entity brief enqueues an LLM skill — strict rate-limit BEFORE default /api/v1/* mount
  app.use('/api/v1/entities/*/brief', rateLimit(strictLimiter))

  // Admin tier: destructive/config endpoints
  app.use('/api/v1/admin/*', rateLimit(adminLimiter))

  // Default tier: everything else under /api/v1
  app.use('/api/v1/*', rateLimit(defaultLimiter))

  // Routes (health, events, metrics are outside /api/v1, intentionally not rate-limited)
  registerHealthRoutes(app)
  registerEventsRoutes(app)
  registerMetricsRoute(app, db, metricsRedis)

  if (configService) {
    const adminRouter = createAdminRouter({ configService, redisConnection, db })
    app.route('/api/v1/admin', adminRouter)
  }

  if (captureService && configService) {
    registerCaptureRoutes(app, captureService, configService, pipelineService)
    registerStatsRoutes(app, captureService)
    registerDocumentRoutes(app, captureService, configService, documentPipelineQueue)
  }

  if (searchService) {
    registerSearchRoutes(app, searchService, accessStatsQueue)
  }

  // Synthesize API
  if (searchService && llmGateway) {
    registerSynthesizeRoutes(app, searchService, llmGateway)
  }

  // Skills API
  if (db && skillQueue) {
    registerSkillRoutes(app, db, skillQueue)
    registerIntelligenceRoutes(app, db, skillQueue)
  }

  // Triggers API
  if (triggerService) {
    registerTriggerRoutes(app, triggerService)
  }

  // Entities API
  if (entityService) {
    // searchService + llmGateway are optional — /ask returns 503 when absent
    // skillQueue is optional — /brief returns 503 when absent
    registerEntityRoutes(app, entityService, searchService, llmGateway, skillQueue)
  }

  // Bets API
  if (betService) {
    registerBetRoutes(app, betService)
  }

  // Sessions API — GovernanceEngine is passed via SessionService constructor in index.ts
  if (sessionService) {
    registerSessionRoutes(app, sessionService)
  }

  // Settings API (generic key-value store — used by email allowlist, etc.)
  if (db) {
    registerSettingsRoutes(app, db)
  }

  // Config API (read-only config + integration status)
  if (configService && db) {
    registerConfigRoutes(app, configService, db)
  }

  // System health API (operational metrics, SSE stream)
  if (systemHealthService) {
    registerSystemHealthRoutes(app, systemHealthService)
  }

  // Wiki API
  if (wikiService) {
    registerWikiRoutes(app, wikiService)
  }

  // Activity feed API + SSE
  if (activityFeedService) {
    registerActivityRoutes(app, activityFeedService)
  }

  // Email drafts API
  if (emailDraftService) {
    registerEmailRoutes(app, emailDraftService, emailComposeAssistService)
  }

  // Voice session API
  if (voiceSessionService) {
    registerVoiceSessionRoutes(app, voiceSessionService)
  }

  // MCP activity log API (read-only, requires db)
  if (db) {
    registerMcpActivityRoutes(app, db)
  }

  // Ingest API — file upload + list/get/process-now (CS3.4).
  // Works without the queue (persists uploads, logs a warning); adding the
  // queue enables the ingest-process pipeline.
  if (db) {
    registerIngestRoutes(app, db, ingestProcessQueue)
  }

  // Insurance policies API — read-only structured coverage data (P22a).
  // Writes performed by scripts/insurance-policy-extract.py (T0 Python).
  // P22b gap analysis depends on this endpoint.
  if (db) {
    registerInsurancePoliciesRoutes(app, db)
  }

  // Briefs API — list, detail, refine (async), dismiss, read toggle (CS2 M2).
  // Audio TTS endpoint (CS5 M3 item 4.1) requires ttsDeps; returns 503 when absent.
  // skillQueue is optional: refine() will throw at runtime if queue absent,
  // but list/get/dismiss/patchRead work without it.
  if (briefsService) {
    registerBriefRoutes(app, briefsService, ttsDeps)
  }

  // Commitments API — list, entity-scoped list, toggle resolved, manual create (CS2 M3).
  // GET /api/v1/commitments, GET /api/v1/entities/:id/commitments,
  // PATCH /api/v1/commitments/:id, POST /api/v1/commitments
  if (db) {
    registerCommitmentRoutes(app, db)
  }

  // MCP endpoint — requires all services to be available
  if (captureService && searchService && configService && db) {
    mountMcpServer(app, { captureService, searchService, configService, db, entityService, wikiService, activityFeedService, emailDraftService, accessStatsQueue })
  }

  return app
}
