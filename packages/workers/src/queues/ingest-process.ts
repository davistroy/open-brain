import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { IngestProcessJobData } from '@open-brain/shared'

/**
 * Patient backoff delays matching the canonical pipeline retry policy
 * (CLAUDE.md): attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5 → 2h.
 *
 * Sidecar dispatch is mostly idempotent (the sidecar serialises with
 * `/tmp/process.lock` and dedupes on content hash), so a long tail of
 * retries is safe. The 2-hour final delay covers cases where the sidecar
 * container is restarting or the compose network is partitioned.
 */
export const INGEST_PROCESS_BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000]

/**
 * Queue for the ingest-process BullMQ job (CS3.5).
 *
 * Enqueued by `POST /api/v1/ingest/upload` and `POST /api/v1/ingest/process-now`
 * (see packages/core-api/src/routes/ingest.ts). Consumer is
 * `createIngestProcessWorker` in packages/workers/src/jobs/ingest-process.ts.
 *
 * Queue name must stay `ingest-process` — it is string-referenced by the
 * core-api Queue constructor in `packages/core-api/src/index.ts`.
 */
export function createIngestProcessQueue(connection: ConnectionOptions): Queue<IngestProcessJobData> {
  return new Queue<IngestProcessJobData>('ingest-process', {
    connection,
    defaultJobOptions: {
      // Higher priority than background access-stats (1) but lower than the
      // capture pipeline (5). Uploads are interactive-ish (dashboard waits
      // on SSE) but not hot path.
      priority: 6,
      attempts: 5,
      backoff: {
        type: 'custom',
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
}

export type IngestProcessQueue = ReturnType<typeof createIngestProcessQueue>
