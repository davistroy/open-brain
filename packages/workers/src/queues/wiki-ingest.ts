import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface WikiIngestJobData {
  captureId: string
}

/**
 * Queue for wiki ingestion — processes captures into wiki pages via LLM agent.
 *
 * Rate-limited to 5 jobs/minute to control LLM cost (Claude subscription).
 * Concurrency=1 to serialize Git operations (no lock contention on the wiki repo).
 * Priority 4 (lower than pipeline, higher than scheduled skills).
 *
 * 3 attempts with exponential backoff. Wiki-ingest failure is non-critical —
 * it must NOT fail the parent pipeline flow (uses removeDependencyOnFailure
 * when wired via FlowProducer).
 */
export function createWikiIngestQueue(connection: ConnectionOptions) {
  return new Queue<WikiIngestJobData>('wiki-ingest', {
    connection,
    defaultJobOptions: {
      priority: 4,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 15_000, // 15s, 30s, 60s
      },
      removeOnComplete: { count: 200 },
      // age bound (14d, DA-9) so stale failures auto-prune — `count` alone
      // never prunes below 100, letting old failures accumulate indefinitely.
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 100 },
    },
  })
}

export type WikiIngestQueue = ReturnType<typeof createWikiIngestQueue>
