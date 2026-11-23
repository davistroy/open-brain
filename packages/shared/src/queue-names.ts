/**
 * One registry of BullMQ queue names (SE7-11).
 *
 * Replaces three hand-kept lists (pipeline-health, core-api admin routes,
 * core-api system-health). `packages/workers/src/__tests__/queue-names.test.ts`
 * asserts WORKER_QUEUES equals the set of queue names passed to `new Worker(`.
 */

/** Queues with a consumer (`new Worker(`) in @open-brain/workers. */
export const WORKER_QUEUES = [
  'capture-pipeline',
  'ingest-root',
  'embed-capture',
  'extract-entities',
  'extract-commitments',
  'check-triggers',
  'wiki-ingest',
  'document-pipeline',
  'ingest-process',
  'skill-execution',
  'access-stats',
  'prune-associations',
  'daily-sweep',
  'budget-check',
  'data-retention-prune',
  'pushover',
  'email',
] as const

/** Queues that are written to but have no consumer in this stack. */
export const PRODUCER_ONLY_QUEUES = ['wiki-lint'] as const

/** Every queue that monitoring, Bull Board and the clear endpoint cover. */
export const ALL_MONITORED_QUEUES = [...WORKER_QUEUES, ...PRODUCER_ONLY_QUEUES] as const

export type WorkerQueueName = (typeof WORKER_QUEUES)[number]
export type MonitoredQueueName = (typeof ALL_MONITORED_QUEUES)[number]
