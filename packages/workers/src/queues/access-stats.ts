import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface AccessStatsJobData {
  captureIds: string[]
  accessedAt: string // ISO 8601 timestamp
}

/**
 * Queue for updating capture access statistics after search.
 * Low priority (1), eventually consistent — single attempt, short timeout.
 */
export function createAccessStatsQueue(connection: ConnectionOptions) {
  return new Queue<AccessStatsJobData>('access-stats', {
    connection,
    defaultJobOptions: {
      priority: 1,      // low priority — best-effort background work
      attempts: 1,      // one attempt only — avoid retry storms on transient failures
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  })
}

export type AccessStatsQueue = ReturnType<typeof createAccessStatsQueue>
