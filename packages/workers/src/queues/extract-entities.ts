import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface ExtractEntitiesJobData {
  captureId: string
}

/**
 * Patient backoff delays matching TDD §12.1:
 * attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 *
 * Entity extraction is non-critical — a failure here does not block the
 * capture from being searchable. The job logs the failure and retries
 * with patient backoff. Stage failure never propagates to the pipeline.
 */
export const EXTRACT_ENTITIES_BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000]

/**
 * Queue for extracting entities from captures after the embed stage.
 *
 * Enqueued by embed-capture job after successful embedding.
 * Priority 7 (lower than embedding at 5, trigger checks at 6).
 * 5 attempts with patient backoff.
 */
export function createExtractEntitiesQueue(connection: ConnectionOptions) {
  return new Queue<ExtractEntitiesJobData>('extract-entities', {
    connection,
    defaultJobOptions: {
      priority: 7,
      attempts: 5,
      backoff: {
        type: 'custom',
      },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 100 },
    },
  })
}

export type ExtractEntitiesQueue = ReturnType<typeof createExtractEntitiesQueue>
