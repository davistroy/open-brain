/**
 * Workers process entry point.
 *
 * Creates Redis + Postgres connections, registers all BullMQ workers
 * and scheduled jobs, then keeps the process alive until SIGTERM/SIGINT.
 */
import { createDb, ConfigService } from '@open-brain/shared'
import { createAllQueues } from './queues/index.js'
import { createIngestionWorker } from './jobs/ingestion-worker.js'
import { createEmbedCaptureWorker } from './jobs/embed-capture.js'
import { createCheckTriggersWorker } from './jobs/check-triggers.js'
import { createExtractEntitiesWorker } from './jobs/extract-entities.js'
import { createDocumentPipelineWorker } from './jobs/document-pipeline.js'
import { createDailySweepWorker } from './jobs/daily-sweep.js'
import { createPushoverWorker } from './jobs/pushover.js'
import { createEmailWorker } from './jobs/email.js'
import { createAccessStatsWorker } from './jobs/update-access-stats.js'
import { createBudgetCheckWorker } from './jobs/budget-check.js'
import { registerScheduledJobs } from './scheduler.js'
import { logger } from './lib/logger.js'
import type { Worker } from 'bullmq'

function parseRedisUrl(url: string) {
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    ...(parsed.password ? { password: parsed.password } : {}),
  }
}

async function main() {
  const postgresUrl = process.env.POSTGRES_URL
  if (!postgresUrl) throw new Error('POSTGRES_URL is required')

  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const litellmUrl = process.env.LITELLM_URL ?? 'http://localhost:4000'
  const litellmApiKey = process.env.LITELLM_API_KEY ?? ''
  const pushoverAppToken = process.env.PUSHOVER_APP_TOKEN
  const pushoverUserKey = process.env.PUSHOVER_USER_KEY
  const configDir = process.env.CONFIG_DIR ?? '/app/config'
  const promptsDir = process.env.PROMPTS_DIR ?? `${configDir}/prompts`

  // Database
  const db = createDb(postgresUrl)
  logger.info('Postgres connected')

  // Config
  const configService = new ConfigService(configDir)
  configService.load()
  logger.info('Config loaded')

  // Redis
  const connection = parseRedisUrl(redisUrl)
  logger.info({ host: connection.host, port: connection.port }, 'Redis connection')

  // Queues
  const queues = createAllQueues(connection)
  logger.info('Queues created')

  // Workers
  const workers: Worker[] = []

  workers.push(createIngestionWorker(connection, db, queues.embedCapture))
  workers.push(createEmbedCaptureWorker(
    connection, db, configService, litellmUrl, litellmApiKey,
    queues.checkTriggers, queues.extractEntities,
  ))
  workers.push(createCheckTriggersWorker(connection, db, pushoverAppToken, pushoverUserKey))
  workers.push(createExtractEntitiesWorker(connection, db, configService, litellmUrl, litellmApiKey, promptsDir))
  workers.push(createDocumentPipelineWorker(connection, db, configService, litellmUrl, litellmApiKey, queues.embedCapture))
  workers.push(createDailySweepWorker(connection, db, queues.capturePipeline))
  workers.push(createPushoverWorker(connection, pushoverAppToken, pushoverUserKey))
  workers.push(createEmailWorker(connection))
  workers.push(createAccessStatsWorker(connection, db))
  workers.push(createBudgetCheckWorker(connection, db, {
    appToken: pushoverAppToken,
    userKey: pushoverUserKey,
    litellmUrl,
    litellmApiKey,
  }))

  logger.info({ count: workers.length }, 'All workers registered')

  // Scheduled jobs
  await registerScheduledJobs(connection)
  logger.info('Scheduled jobs registered')

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Shutting down workers...')
    await Promise.allSettled(workers.map(w => w.close()))
    await Promise.allSettled(Object.values(queues).map(q => q.close()))
    logger.info('All workers closed')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  logger.info('Workers process ready — waiting for jobs')
}

main().catch(err => {
  logger.fatal(err, 'Workers startup failed')
  process.exit(1)
})
