import { Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database, ConfigService } from '@open-brain/shared'
import { logger, TemplateCache } from '@open-brain/shared'
import type { WikiGitService } from '@open-brain/shared'
import type { WikiIngestJobData } from '../queues/wiki-ingest.js'
import { executeWikiIngest } from '../skills/wiki-ingest.js'

/**
 * BullMQ worker that consumes the `wiki-ingest` queue.
 *
 * Rate-limited to 5 jobs/minute (12s interval) to control LLM cost.
 * Concurrency=1 to serialize Git operations on the wiki repository.
 *
 * The worker is registered only when WikiGitService is available
 * (WIKI_REPO_URL is set and init succeeds).
 */
export function createWikiIngestWorker(
  connection: ConnectionOptions,
  db: Database,
  opts: {
    wikiService: WikiGitService
    anthropicClient?: Anthropic
    configService?: ConfigService
    promptsDir?: string
    templates?: TemplateCache
  },
): Worker<WikiIngestJobData> {
  const worker = new Worker<WikiIngestJobData>(
    'wiki-ingest',
    async (job) => {
      const { captureId } = job.data

      logger.info({ captureId, jobId: job.id }, '[wiki-ingest-worker] job received')

      const result = await executeWikiIngest(db, captureId, opts.wikiService, {
        anthropicClient: opts.anthropicClient,
        configService: opts.configService,
        promptsDir: opts.promptsDir,
        templates: opts.templates,
      })

      if (result.skipped) {
        logger.info(
          { captureId, reason: result.skipReason },
          '[wiki-ingest-worker] capture skipped',
        )
      } else {
        logger.info(
          {
            captureId,
            pagesCreated: result.pagesCreated.length,
            pagesUpdated: result.pagesUpdated.length,
            indexUpdated: result.indexUpdated,
            durationMs: result.durationMs,
          },
          '[wiki-ingest-worker] job completed',
        )
      }
    },
    {
      connection,
      concurrency: 1, // Serialize Git operations — no lock contention
      limiter: {
        max: 5,
        duration: 60_000, // 5 jobs per 60 seconds
      },
    },
  )

  worker.on('completed', (job) => {
    logger.debug({ captureId: job.data.captureId, jobId: job.id }, '[wiki-ingest-worker] job completed')
  })

  worker.on('failed', (job, err) => {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isGiteaUnavailable = errMsg.includes('ECONNREFUSED')
      || errMsg.includes('ENOTFOUND')
      || errMsg.includes('ETIMEDOUT')
      || errMsg.includes('connect EHOSTUNREACH')
      || errMsg.includes('git push')

    if (isGiteaUnavailable) {
      logger.warn(
        { captureId: job?.data.captureId, jobId: job?.id, err: errMsg, attemptsLeft: job ? (job.opts.attempts ?? 3) - job.attemptsMade : 0 },
        '[wiki-ingest-worker] Gitea appears unavailable — job will retry via BullMQ backoff',
      )
    } else {
      logger.error(
        { captureId: job?.data.captureId, jobId: job?.id, err },
        '[wiki-ingest-worker] job failed',
      )
    }
  })

  return worker
}
