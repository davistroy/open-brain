import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface CheckTriggersJobData {
  captureId: string
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
      removeOnFail: { count: 100 },
    },
  })
}

export type CheckTriggersQueue = ReturnType<typeof createCheckTriggersQueue>
