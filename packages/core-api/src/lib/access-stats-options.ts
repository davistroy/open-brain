/**
 * Shared defaultJobOptions for the access-stats BullMQ Queue.
 *
 * DA-M3: BullMQ reads retention (removeOnComplete/removeOnFail) from the
 * PRODUCER's add-time options, not the consumer's worker config.  Both the
 * core-api producer (index.ts) and the workers consumer
 * (packages/workers/src/queues/access-stats.ts) must declare the same values
 * so jobs are pruned from Redis.  This module is the single source of truth —
 * import from here to keep both sides in sync.
 */
export const ACCESS_STATS_JOB_OPTIONS = {
  priority: 1,        // low priority — best-effort background work
  attempts: 1,        // one attempt only — avoid retry storms
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
} as const
