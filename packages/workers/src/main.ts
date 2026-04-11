/**
 * Workers process entry point.
 *
 * Creates Redis + Postgres connections, registers all BullMQ workers
 * and scheduled jobs, then keeps the process alive until SIGTERM/SIGINT.
 */
import { Redis } from 'ioredis'
import { createDb, ConfigService, createAnthropicClient } from '@open-brain/shared'
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
import { createSkillExecutionWorker } from './jobs/skill-execution.js'
import { createIngestRootWorker } from './jobs/ingest-root.js'
import { createWikiIngestWorker } from './jobs/wiki-ingest-worker.js'
import { registerScheduledJobs } from './scheduler.js'
import { SpendTracker } from './lib/spend-tracker.js'
import { IngestDedup } from './lib/ingest-dedup.js'
import { logger, TemplateCache, PushoverService, WikiGitService } from '@open-brain/shared'
import { FlowProducer } from 'bullmq'
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

  // LITELLM_API_KEY check
  if (!litellmApiKey) {
    logger.warn('LITELLM_API_KEY not set — embedding, entity extraction, and skill execution will fail')
  }

  // Anthropic client for Claude SDK routing (used by skill-execution and future agentic workers)
  const anthropicClient = createAnthropicClient({ maxRetries: 0 }) // BullMQ handles retries
  if (anthropicClient) {
    logger.info('Anthropic client initialized (Claude subscription)')
  } else {
    logger.warn('ANTHROPIC_API_KEY not set — Claude SDK features unavailable in workers')
  }

  // Template cache (shared across all workers that load prompt templates)
  const templates = new TemplateCache(promptsDir)

  // Pushover service (shared, throws on error for BullMQ retry)
  const pushover = new PushoverService({
    appToken: pushoverAppToken,
    userKey: pushoverUserKey,
    onError: 'throw',
  })

  // Database
  const { db, pool } = createDb(postgresUrl)
  logger.info('Postgres connected')

  // Config
  const configService = new ConfigService(configDir)
  configService.load()
  logger.info('Config loaded')

  // Redis
  const connection = parseRedisUrl(redisUrl)
  logger.info({ host: connection.host, port: connection.port }, 'Redis connection')

  // Wiki Git service (optional — requires WIKI_REPO_URL)
  const wikiRepoUrl = process.env.WIKI_REPO_URL
  const wikiLocalPath = process.env.WIKI_LOCAL_PATH ?? '/tmp/open-brain-wiki'
  let wikiService: WikiGitService | undefined

  if (wikiRepoUrl) {
    wikiService = new WikiGitService({
      repoUrl: wikiRepoUrl,
      localPath: wikiLocalPath,
    })
    try {
      await wikiService.init()
      logger.info({ repoUrl: wikiRepoUrl, localPath: wikiLocalPath }, 'WikiGitService initialized')
    } catch (err) {
      logger.warn({ err }, 'WikiGitService init failed — wiki-ingest will be unavailable')
      wikiService = undefined
    }
  } else {
    logger.info('WIKI_REPO_URL not set — wiki-ingest worker disabled')
  }

  // Queues
  const queues = createAllQueues(connection)
  logger.info('Queues created')

  // Spend-aware rate limiter for embed queue (non-Claude spend only)
  const spendTracker = new SpendTracker(db)
  logger.info('SpendTracker initialized (non-Claude spend limits)')

  // Redis-based content hash dedup for ingestion pipeline
  const dedupRedis = new Redis({
    host: connection.host as string,
    port: connection.port as number,
    ...(connection.password ? { password: connection.password as string } : {}),
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  })
  await dedupRedis.connect()
  const ingestDedup = new IngestDedup(dedupRedis)
  logger.info('IngestDedup initialized (5-min TTL content hash dedup)')

  // FlowProducer — enabled via PIPELINE_USE_FLOWS=true feature flag
  const useFlows = process.env.PIPELINE_USE_FLOWS === 'true'
  let flowProducer: FlowProducer | undefined

  if (useFlows) {
    flowProducer = new FlowProducer({ connection })
    logger.info('FlowProducer initialized — pipeline will use DAG-based orchestration')
  } else {
    logger.info('FlowProducer disabled — using legacy queue bridging (set PIPELINE_USE_FLOWS=true to enable)')
  }

  // Workers
  const workers: Worker[] = []

  workers.push(createIngestionWorker(connection, db, queues.embedCapture, flowProducer, ingestDedup))
  workers.push(createEmbedCaptureWorker(
    connection, db, configService, litellmUrl, litellmApiKey,
    queues.checkTriggers, queues.extractEntities, spendTracker,
  ))
  // Ingest-root worker — processes the FlowProducer root job after children complete
  // Always registered so it can drain jobs if flows were previously enabled
  workers.push(createIngestRootWorker(connection, db, queues.checkTriggers))

  workers.push(createCheckTriggersWorker(connection, db, pushoverAppToken, pushoverUserKey))
  workers.push(createExtractEntitiesWorker(connection, db, configService, litellmUrl, litellmApiKey, templates))
  workers.push(createDocumentPipelineWorker(connection, db, configService, litellmUrl, litellmApiKey, queues.embedCapture))
  workers.push(createDailySweepWorker(connection, db, queues.capturePipeline))
  workers.push(createPushoverWorker(connection, pushoverAppToken, pushoverUserKey))
  workers.push(createEmailWorker(connection))
  workers.push(createAccessStatsWorker(connection, db))
  workers.push(createBudgetCheckWorker(connection, db, {
    appToken: pushoverAppToken,
    userKey: pushoverUserKey,
    litellmSpendUrl: process.env.LITELLM_SPEND_URL ?? '',
    litellmApiKey,
  }))
  workers.push(createSkillExecutionWorker(connection, db, {
    litellmUrl,
    litellmApiKey,
    promptsDir,
    coreApiUrl: process.env.OPEN_BRAIN_API_URL ?? 'http://core-api:3000',
    configService,
    anthropicClient: anthropicClient ?? undefined,
    wikiService,
  }))

  // Wiki-ingest worker — dedicated worker for wiki integration (rate-limited, concurrency=1)
  if (wikiService) {
    workers.push(createWikiIngestWorker(connection, db, {
      wikiService,
      anthropicClient: anthropicClient ?? undefined,
      promptsDir,
      templates,
    }))
  }

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
    if (flowProducer) await flowProducer.close().catch(() => {})
    await dedupRedis.quit().catch(() => {})
    logger.info('All workers, queues, flow producer, and dedup Redis closed')
    await pool.end()
    logger.info('Postgres pool closed')
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
