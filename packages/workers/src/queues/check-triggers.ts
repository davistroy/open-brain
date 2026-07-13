import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface CheckTriggersJobData {
  captureId: string
  /** Pipeline trace ID (UUID v4) for cross-stage correlation in logs and pipeline_events */
  traceId?: string
}

/**
 * Queue for checking new captures against active semantic triggers.
 *
 * Enqueued by the embed pipeline stage after a capture is successfully embedded.
 * Priority 6 (between embedding at 5 and notifications at 7).
 * 3 attempts with exponential backoff — trigger check is non-critical; if the
 * DB is temporarily unavailable, retry gracefully.
 */
export function createCheckTriggersQueue(connection: ConnectionOptions) {
  return new Queue<CheckTriggersJobData>('check-triggers', {
    connection,
    defaultJobOptions: {
      priority: 6,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5_000, // 5s, 10s, 20s
      },
      removeOnComplete: { count: 500 },
      // age bound (14d, DA-9) so stale failures auto-prune — `count` alone
      // never prunes below 100, letting old failures accumulate indefinitely.
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 100 },
    },
  })
}

export type CheckTriggersQueue = ReturnType<typeof createCheckTriggersQueue>
