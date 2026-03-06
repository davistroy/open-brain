import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface DocumentPipelineJobData {
  /** UUID of the parent document capture (source='document') */
  captureId: string
}

/**
 * Patient backoff delays matching TDD §12.1:
 * attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h
 */
export const DOCUMENT_PIPELINE_BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000]

/**
 * Queue for processing document captures through the document pipeline.
 *
 * Jobs are enqueued by the document upload API (16.2) after a document capture
 * is created with source='document'. The worker parses the document, chunks it
 * into ≤8K-token segments with 512-token overlap, creates sub-captures for each
 * chunk (linked via parent_id in source_metadata), and embeds each chunk.
 *
 * Priority 4 (lower than normal captures at 5 — document processing is batch).
 * 5 attempts, patient backoff (30s / 2m / 10m / 30m / 2h).
 */
export function createDocumentPipelineQueue(connection: ConnectionOptions) {
  return new Queue<DocumentPipelineJobData>('document-pipeline', {
    connection,
    defaultJobOptions: {
      priority: 4,
      attempts: 5,
      backoff: {
        type: 'custom',
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
}

export type DocumentPipelineQueue = ReturnType<typeof createDocumentPipelineQueue>
