import type { FlowJob } from 'bullmq'

/**
 * Build a BullMQ FlowProducer DAG definition for the capture ingestion pipeline.
 *
 * BullMQ FlowProducer tree semantics:
 *   - Children execute BEFORE their parent
 *   - Parent runs only after all children complete (or are removed from deps)
 *
 * DAG structure:
 *
 *   ingest-root (parent — runs LAST after children)
 *   ├── embed-capture (child — critical, failParentOnFailure: true)
 *   └── extract-entities (child — non-critical, removeDependencyOnFailure: true)
 *
 * When both children complete, ingest-root runs. Its handler:
 *   1. Calls processLinkEntitiesStage() inline
 *   2. Enqueues check-triggers (non-critical)
 *
 * Failure semantics:
 *   - embed-capture failure → failParentOnFailure → ingest-root fails → pipeline stuck
 *     (daily sweep re-enqueues stuck captures, preserving existing retry semantics)
 *   - extract-entities failure → removeDependencyOnFailure → ingest-root still runs
 *     (entity extraction is enrichment, not a pipeline gate)
 *
 * Pipeline status flow is UNCHANGED:
 *   - ingestion-worker: pending → processing → extracted
 *   - embed-capture: extracted → embedded → complete (hard gate)
 *   - extract-entities + link-entities: enrichment only, no status change
 *
 * @param captureId - UUID of the capture to process
 * @returns FlowJob tree definition for FlowProducer.add()
 */
export function buildIngestFlow(captureId: string): FlowJob {
  return {
    name: 'ingest-root',
    queueName: 'ingest-root',
    data: { captureId },
    opts: {
      jobId: `ingest-root_${captureId}`,
    },
    children: [
      {
        name: 'embed',
        queueName: 'embed-capture',
        data: { captureId },
        opts: {
          jobId: `embed_${captureId}`,
          failParentOnFailure: true,
          attempts: 5,
          backoff: { type: 'custom' },
        },
      },
      {
        name: 'extract-entities',
        queueName: 'extract-entities',
        data: { captureId },
        opts: {
          jobId: `extract-entities_${captureId}`,
          removeDependencyOnFailure: true,
          attempts: 5,
          backoff: { type: 'custom' },
        },
      },
    ],
  }
}

/**
 * Queue name for the ingest-root parent job.
 * Workers must register a processor for this queue.
 */
export const INGEST_ROOT_QUEUE_NAME = 'ingest-root'

/**
 * Job data for the ingest-root queue.
 */
export interface IngestRootJobData {
  captureId: string
}
