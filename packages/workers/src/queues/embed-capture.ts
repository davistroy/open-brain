import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface EmbedCaptureJobData {
  captureId: string
}

/**
 * Patient backoff delays matching TDD §12.1:
 * attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 *
 * Embedding failures are non-recoverable within the job — BullMQ retries
 * with patient backoff until the LiteLLM service is available again.
 * NO fallback is attempted per architecture decision.
 */
export const EMBED_BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000]

/**
 * Queue for embedding captures after the extract stage completes.
 *
 * Priority 5, 5 attempts, patient backoff.
 * Embed failures must throw so BullMQ retries — this is the hard gate:
 * a capture cannot advance to 'embedded' or 'complete' without a valid embedding.
 */
export function createEmbedCaptureQueue(connection: ConnectionOptions) {
  return new Queue<EmbedCaptureJobData>('embed-capture', {
    connection,
    defaultJobOptions: {
      priority: 5,
      attempts: 5,
      backoff: {
        type: 'custom',
      },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 100 },
    },
  })
}

export type EmbedCaptureQueue = ReturnType<typeof createEmbedCaptureQueue>
