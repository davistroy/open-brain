import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { ConfigService, createDb } from '@open-brain/shared'
import { createApp } from './app.js'
import { CaptureService } from './services/capture.js'
import { logger } from './lib/logger.js'

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

const app = createApp({ configService, captureService, redisConnection })
const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'Core API listening')
})

export { app }
