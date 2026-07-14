import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface CapturePipelineJobData {
  captureId: string
  /** Optional pipeline name — defaults to 'default' when not specified */
  pipelineName?: string
  /** Pipeline trace ID (UUID v4) for cross-stage correlation in logs and pipeline_events */
  traceId?: string
  /**
   * When true, the ingestion worker bypasses the terminal-status guard for
   * 'failed' captures and reprocesses from the beginning.  Set by the
   * POST /api/v1/captures/:id/retry endpoint via PipelineService.enqueue().
   * 'complete' and 'deleted' remain terminal regardless of this flag.
   */
  forceRetry?: boolean
}

/**
 * Patient backoff delays matching TDD §12.1:
 * attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 *
 * BullMQ custom backoff strategy reads the delay array from job data.
 * We configure a fixed custom delay per-job by overriding at enqueue time,
 * but set the default attempts here so BullMQ knows when to give up.
 */
export const PIPELINE_BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000]

/**
 * Queue for processing captures through the ingestion pipeline.
 * Priority 5, 5 attempts, patient backoff [30s, 2m, 10m, 30m, 2h].
 *
 * Embed stage failures MUST throw so BullMQ retries with backoff.
 * Other stage failures surface as partial completion status.
 */
export function createCapturePipelineQueue(connection: ConnectionOptions) {
  return new Queue<CapturePipelineJobData>('capture-pipeline', {
    connection,
    defaultJobOptions: {
      priority: 5,
      attempts: 5,
      backoff: {
        type: 'custom',
      },
      removeOnComplete: { count: 500 },
      // age bound (14d, DA-9) so stale failures auto-prune — `count` alone
      // never prunes below 100, letting old failures accumulate indefinitely.
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 100 },
    },
  })
}

export type CapturePipelineQueue = ReturnType<typeof createCapturePipelineQueue>
