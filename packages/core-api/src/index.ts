import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { Queue } from 'bullmq'
import { ConfigService, createDb, createOpenAIClient, createAnthropicClient, createOllamaClient, TemplateCache } from '@open-brain/shared'
import { createApp } from './app.js'
import { CaptureService } from './services/capture.js'
import { EmbeddingService } from '@open-brain/shared'
import { SearchService } from './services/search.js'
import { TriggerService } from './services/trigger.js'
import { EntityService } from './services/entity.js'
import { EntityResolutionService } from './services/entity-resolution.js'
import { BetService } from './services/bet.js'
import { SessionService } from './services/session.js'
import { PipelineService } from './services/pipeline.js'
import { LLMGatewayService } from '@open-brain/shared'
import { GovernanceEngine } from './services/governance-engine.js'
import { SkillConfigService, initSkillConfigSingleton } from './services/skill-config.js'
import { logger } from '@open-brain/shared'
import { SystemHealthService } from './services/system-health.js'
import { WikiService } from './services/wiki.js'
import { ActivityFeedService } from './services/activity-feed.js'
import { EmailDraftService } from './services/email-draft.js'
import { VoiceSessionService } from './services/voice-session.js'
import { HimalayaService, PushoverService } from '@open-brain/shared'
import { pgNotify } from './lib/pg-notify.js'

// Load config
const configDir = join(process.cwd(), 'config')
const configService = new ConfigService(configDir)
configService.load()
logger.info('Config loaded successfully')

// Load skill schedule overrides from config/skills.yaml (if present)
const skillConfigService = new SkillConfigService(join(configDir, 'skills.yaml'))
skillConfigService.load()
initSkillConfigSingleton(skillConfigService)

// Initialize DB
const postgresUrl = process.env.POSTGRES_URL ?? 'postgresql://openbrain:openbrain_dev@localhost:5432/openbrain'
const { db, pool } = createDb(postgresUrl)

// Redis connection for Bull Board queue monitoring and BullMQ queues
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const redisUrlObj = new URL(redisUrl)
const redisConnection = {
  host: redisUrlObj.hostname,
  port: Number(redisUrlObj.port) || 6379,
  ...(redisUrlObj.password ? { password: redisUrlObj.password } : {}),
}

// LLM Gateway + Governance Engine
// OPENAI_BASE_URL / OPENAI_API_KEY come from environment (set via bws secrets at startup).
// Legacy shim: falls back to LITELLM_URL / LITELLM_API_KEY during deploy rename window.
const openaiBaseUrl = process.env.OPENAI_BASE_URL ?? process.env.LITELLM_URL ?? 'https://api.openai.com/v1'
const openaiApiKey = process.env.OPENAI_API_KEY ?? process.env.LITELLM_API_KEY ?? ''

// Startup validation — catch the "old LiteLLM virtual key deployed against api.openai.com" mistake.
if (openaiApiKey.startsWith('sk-litellm-')) {
  logger.fatal(
    { keyPrefix: openaiApiKey.slice(0, 12) + '...' },
    'OPENAI_API_KEY appears to be a LiteLLM proxy virtual key (sk-litellm-…). ' +
    'This is the old deploy config and will fail against api.openai.com/v1 with 401. ' +
    'Update .env.secrets with the real OpenAI key from Bitwarden item open-brain-openai-api-key.',
  )
  process.exit(1)
}

const promptsDir = join(configDir, 'prompts')
const templateCache = new TemplateCache(promptsDir)

// BullMQ queues
const capturePipelineQueue = new Queue('capture-pipeline', { connection: redisConnection })
const skillQueue = new Queue('skill-execution', { connection: redisConnection })
const documentPipelineQueue = new Queue('document-pipeline', { connection: redisConnection })

// Services — instantiation order respects dependency graph
const pipelineService = new PipelineService(capturePipelineQueue)
const captureService = new CaptureService(db, pipelineService)
const embeddingService = new EmbeddingService({ baseUrl: openaiBaseUrl, apiKey: openaiApiKey, configService })
const searchService = new SearchService(db, embeddingService)
const triggerService = new TriggerService(db, embeddingService)
const entityResolutionService = new EntityResolutionService(db)
const entityService = new EntityService(db, entityResolutionService)
const betService = new BetService(db)

const anthropicClient = createAnthropicClient({ maxRetries: 2 })
const ollamaClient = createOllamaClient()
// Optional generic OpenAI client — only used if a tier declares provider: 'litellm'/'openai'
// (no openai_compat). Currently no tier does; kept as an escape hatch. Factory returns null
// when the API key is empty.
const openaiClient = createOpenAIClient({ baseUrl: openaiBaseUrl, apiKey: openaiApiKey })
if (anthropicClient) {
  logger.info('Anthropic client initialized (Claude subscription)')
} else {
  logger.warn('ANTHROPIC_API_KEY not set — Anthropic tiers will be unavailable')
}
if (ollamaClient) {
  logger.info('Ollama client initialized (local inference)')
} else {
  logger.info('OLLAMA_URL not set — Ollama local inference unavailable, tier fallback will skip T0')
}

const llmGateway = new LLMGatewayService(configService, db, templateCache, anthropicClient, ollamaClient, openaiClient)
const governanceEngine: GovernanceEngine = new GovernanceEngine(llmGateway, templateCache)
logger.info('GovernanceEngine initialized')

const sessionService = new SessionService(db, captureService, governanceEngine)

// Activity feed service — wire into capture service for automatic feed inserts
const activityFeedService = new ActivityFeedService(db)
captureService.setActivityFeedService(activityFeedService)

// Email draft service — HimalayaService for SMTP sending, PushoverService for review notifications
const himalayaService = new HimalayaService()
const emailPushover = new PushoverService({ onError: 'swallow' })
const emailDraftService = new EmailDraftService(db, himalayaService, emailPushover)
emailDraftService.setActivityFeedService(activityFeedService)
if (himalayaService.isConfigured) {
  logger.info('HimalayaService configured — outbound email enabled')
} else {
  logger.info('HIMALAYA_CONFIG not set — outbound email disabled (drafts still work)')
}

// Voice session service — manages Pipecat voice conversation sessions
const voiceSessionService = new VoiceSessionService(db)
voiceSessionService.setActivityFeedService(activityFeedService)

// Wiki service — optional, requires WIKI_REPO_URL and WIKI_LOCAL_PATH env vars
let wikiService: WikiService | undefined
let wikiIngestQueue: Queue | undefined
let wikiLintQueue: Queue | undefined
const wikiRepoUrl = process.env.WIKI_REPO_URL
const wikiLocalPath = process.env.WIKI_LOCAL_PATH
if (wikiRepoUrl && wikiLocalPath) {
  wikiIngestQueue = new Queue('wiki-ingest', { connection: redisConnection })
  wikiLintQueue = new Queue('wiki-lint', { connection: redisConnection })
  wikiService = new WikiService({
    repoUrl: wikiRepoUrl,
    localPath: wikiLocalPath,
    wikiIngestQueue,
    wikiLintQueue,
  })
  wikiService.init().then(() => {
    logger.info('WikiService initialized')
  }).catch((err) => {
    logger.warn({ err }, 'WikiService init failed — wiki endpoints will return errors')
  })
} else {
  logger.info('WIKI_REPO_URL or WIKI_LOCAL_PATH not set — wiki endpoints disabled')
}

// System health service — includes wiki status when configured
const systemHealthService = new SystemHealthService(db, redisConnection, redisUrl, wikiService)

const app = createApp({
  configService,
  captureService,
  searchService,
  pipelineService,
  db,
  redisConnection,
  skillQueue,
  triggerService,
  entityService,
  betService,
  sessionService,
  documentPipelineQueue,
  llmGateway,
  systemHealthService,
  wikiService,
  activityFeedService,
  emailDraftService,
  voiceSessionService,
})
const port = Number(process.env.PORT ?? 3000)

// Start Postgres LISTEN/NOTIFY for SSE event broadcasting
pgNotify.start(postgresUrl).catch((err) => {
  logger.warn({ err }, 'pg-notify failed to start — SSE events unavailable')
})

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'Core API listening')
})

// Graceful shutdown
let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('Shutting down...')

  // 1. Close BullMQ queues (stop accepting new jobs)
  const queueClosePromises = [
    capturePipelineQueue.close(),
    skillQueue.close(),
    documentPipelineQueue.close(),
  ]
  if (wikiIngestQueue) queueClosePromises.push(wikiIngestQueue.close())
  if (wikiLintQueue) queueClosePromises.push(wikiLintQueue.close())
  await Promise.allSettled(queueClosePromises)
  logger.info('BullMQ queues closed')

  // 2. Stop Postgres LISTEN/NOTIFY
  await pgNotify.stop()

  // 3. Close Postgres connection pool
  await pool.end()
  logger.info('Postgres pool closed')

  // 4. Close HTTP server
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export { app }
