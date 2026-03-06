import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { ConfigService, createDb } from '@open-brain/shared'
import { createApp } from './app.js'
import { CaptureService } from './services/capture.js'
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
const captureService = new CaptureService(db)

// Redis connection for Bull Board queue monitoring
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

let governanceEngine: GovernanceEngine | undefined
if (litellmApiKey) {
  const llmGateway = new LLMGatewayService(litellmUrl, litellmApiKey, configService, db, promptsDir)
  governanceEngine = new GovernanceEngine(llmGateway, promptsDir)
  logger.info('GovernanceEngine initialized')
} else {
  logger.warn('LITELLM_API_KEY not set — GovernanceEngine disabled (session responds will use fallback)')
}

const app = createApp({ configService, captureService, db, redisConnection, governanceEngine })
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
