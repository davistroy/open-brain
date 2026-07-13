import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface ExtractCommitmentsJobData {
  captureId: string
  /** Pipeline trace ID (UUID v4) for cross-stage correlation in logs and pipeline_events */
  traceId?: string
}

/**
 * Patient backoff delays — same schedule as extract-entities:
 * attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 *
 * Commitment extraction is non-critical enrichment. A failure here does not
 * block the capture from being searchable. The job retries with patient backoff.
 */
export const EXTRACT_COMMITMENTS_BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000]

/**
 * Queue for extracting forward-looking obligations from captures.
 *
 * Non-critical DAG child — parallel to extract-entities in the ingest pipeline.
 * removeDependencyOnFailure: true in the FlowProducer DAG so the ingest-root
 * parent still completes even if commitment extraction fails.
 *
 * Priority 8 (lower than extract-entities at 7 — commitment extraction is
 * enrichment, not pipeline-critical).
 */
export function createExtractCommitmentsQueue(connection: ConnectionOptions) {
  return new Queue<ExtractCommitmentsJobData>('extract-commitments', {
    connection,
    defaultJobOptions: {
      priority: 8,
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

export type ExtractCommitmentsQueue = ReturnType<typeof createExtractCommitmentsQueue>
