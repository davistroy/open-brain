import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { Queue } from 'bullmq'
import { ConfigService, createDb } from '@open-brain/shared'
import { createApp } from './app.js'
import { CaptureService } from './services/capture.js'
import { EmbeddingService } from './services/embedding.js'
import { SearchService } from './services/search.js'
import { TriggerService } from './services/trigger.js'
import { EntityService } from './services/entity.js'
import { BetService } from './services/bet.js'
import { SessionService } from './services/session.js'
import { PipelineService } from './services/pipeline.js'
import { LLMGatewayService } from './services/llm-gateway.js'
import { GovernanceEngine } from './services/governance-engine.js'
import { logger } from './lib/logger.js'
import { pgNotify } from './lib/pg-notify.js'

// Load config
const configDir = join(process.cwd(), 'config')
const configService = new ConfigService(configDir)
configService.load()
logger.info('Config loaded successfully')

// Initialize DB
const postgresUrl = process.env.POSTGRES_URL ?? 'postgresql://openbrain:openbrain_dev@localhost:5432/openbrain'
const db = createDb(postgresUrl)

// Redis connection for Bull Board queue monitoring and BullMQ queues
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const redisUrlObj = new URL(redisUrl)
const redisConnection = {
  host: redisUrlObj.hostname,
  port: Number(redisUrlObj.port) || 6379,
  ...(redisUrlObj.password ? { password: redisUrlObj.password } : {}),
}

// LLM Gateway + Governance Engine
// LITELLM_URL and LITELLM_API_KEY come from environment (set via bws secrets at startup)
const litellmUrl = process.env.LITELLM_URL ?? 'https://llm.k4jda.net'
const litellmApiKey = process.env.LITELLM_API_KEY ?? ''
const promptsDir = join(configDir, 'prompts')

// BullMQ queues
const capturePipelineQueue = new Queue('capture-pipeline', { connection: redisConnection })
const skillQueue = new Queue('skill-execution', { connection: redisConnection })
const documentPipelineQueue = new Queue('document-pipeline', { connection: redisConnection })

// Services — instantiation order respects dependency graph
const pipelineService = new PipelineService(capturePipelineQueue)
const captureService = new CaptureService(db, pipelineService)
const embeddingService = new EmbeddingService(litellmUrl, litellmApiKey, configService)
const searchService = new SearchService(db, embeddingService)
const triggerService = new TriggerService(db, embeddingService)
const entityService = new EntityService(db)
const betService = new BetService(db)

let governanceEngine: GovernanceEngine | undefined
let llmGateway: InstanceType<typeof LLMGatewayService> | undefined
if (litellmApiKey) {
  llmGateway = new LLMGatewayService(litellmUrl, litellmApiKey, configService, db, promptsDir)
  governanceEngine = new GovernanceEngine(llmGateway, promptsDir)
  logger.info('GovernanceEngine initialized')
} else {
  logger.warn('LITELLM_API_KEY not set — GovernanceEngine and synthesize endpoint disabled')
}

const sessionService = new SessionService(db, captureService, governanceEngine)

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
  governanceEngine,
  documentPipelineQueue,
  llmGateway,
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
const shutdown = async () => {
  logger.info('Shutting down...')
  await pgNotify.stop()
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export { app }
