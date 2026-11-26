/**
 * defaultJobOptions for the core-api producers of the five pipeline queues
 * (item 9.3, PE-004).
 *
 * BullMQ applies retention at the PRODUCER's add-time, so core-api's queues must
 * declare the same options as the workers-side factories in
 * packages/workers/src/queues/. core-api does not import @open-brain/workers;
 * `__tests__/queue-job-options.test.ts` pins the values inline.
 */
const FAIL_RETENTION = { age: 14 * 24 * 60 * 60, count: 100 } as const // 14 days

export const CAPTURE_PIPELINE_JOB_OPTIONS = {
  priority: 5,
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 500 },
  removeOnFail: FAIL_RETENTION,
} as const

export const SKILL_EXECUTION_JOB_OPTIONS = {
  priority: 3,
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: FAIL_RETENTION,
} as const

export const DOCUMENT_PIPELINE_JOB_OPTIONS = {
  priority: 4,
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 200 },
  removeOnFail: FAIL_RETENTION,
} as const

export const INGEST_PROCESS_JOB_OPTIONS = {
  priority: 6,
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 200 },
  removeOnFail: FAIL_RETENTION,
} as const

export const WIKI_INGEST_JOB_OPTIONS = {
  priority: 4,
  attempts: 3,
  backoff: { type: 'exponential', delay: 15_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: FAIL_RETENTION,
} as const
