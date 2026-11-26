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
 *   ingest-root (parent -- runs LAST after children)
 *   +-- embed-capture (child -- critical, failParentOnFailure: true)
 *   +-- extract-entities (child -- non-critical, removeDependencyOnFailure: true)
 *   +-- extract-commitments (child -- non-critical, removeDependencyOnFailure: true)
 *   +-- wiki-ingest (child -- non-critical, removeDependencyOnFailure: true, optional)
 *
 * When all children complete, ingest-root runs. Its handler:
 *   1. Calls processLinkEntitiesStage() inline
 *   2. Enqueues check-triggers (non-critical)
 *
 * Failure semantics:
 *   - embed-capture failure -> failParentOnFailure -> ingest-root fails -> pipeline stuck
 *     (daily sweep re-enqueues stuck captures, preserving existing retry semantics)
 *   - extract-entities failure -> removeDependencyOnFailure -> ingest-root still runs
 *     (entity extraction is enrichment, not a pipeline gate)
 *   - extract-commitments failure -> removeDependencyOnFailure -> ingest-root still runs
 *     (commitment extraction is enrichment, not a pipeline gate)
 *   - wiki-ingest failure -> removeDependencyOnFailure -> ingest-root still runs
 *     (wiki integration is non-critical enrichment)
 *
 * Pipeline status flow is UNCHANGED:
 *   - ingestion-worker: pending -> processing -> extracted
 *   - embed-capture: extracted -> embedded -> complete (hard gate)
 *   - extract-entities + link-entities: enrichment only, no status change
 *   - extract-commitments: enrichment only, no status change
 *   - wiki-ingest: enrichment only, no status change
 *
 * Embed-only variant (opts.embedOnly, used by flows/redrive.ts):
 *
 *   ingest-root (parent)
 *   +-- embed-capture (child -- critical, failParentOnFailure: true)
 *
 * The enrichment children are left out on purpose: a re-drive after a failed
 * embed must not re-run extract-entities / extract-commitments / wiki-ingest
 * (paid and, for commitments, not idempotent). includeWikiIngest is ignored.
 *
 * @param captureId - UUID of the capture to process
 * @param opts - Optional flags to control which children are included
 * @param opts.includeWikiIngest - When true, adds wiki-ingest as a non-critical child
 * @param opts.traceId - Pipeline trace ID (UUID v4) for cross-stage correlation
 * @param opts.embedOnly - When true, returns the root job and the embed child only
 * @returns FlowJob tree definition for FlowProducer.add()
 */
export function buildIngestFlow(
  captureId: string,
  opts?: { includeWikiIngest?: boolean; traceId?: string; embedOnly?: boolean },
): FlowJob {
  const embedChild: FlowJob = {
    name: 'embed',
    queueName: 'embed-capture',
    data: { captureId, traceId: opts?.traceId },
    opts: {
      jobId: `embed_${captureId}`,
      failParentOnFailure: true,
      attempts: 5,
      backoff: { type: 'custom' },
    },
  }

  const root = (children: FlowJob[]): FlowJob => ({
    name: 'ingest-root',
    queueName: 'ingest-root',
    data: { captureId, traceId: opts?.traceId },
    opts: {
      jobId: `ingest-root_${captureId}`,
    },
    children,
  })

  if (opts?.embedOnly) {
    return root([embedChild])
  }

  const children: FlowJob[] = [
    embedChild,
    {
      name: 'extract-entities',
      queueName: 'extract-entities',
      data: { captureId, traceId: opts?.traceId },
      opts: {
        jobId: `extract-entities_${captureId}`,
        removeDependencyOnFailure: true,
        attempts: 5,
        backoff: { type: 'custom' },
      },
    },
    {
      name: 'extract-commitments',
      queueName: 'extract-commitments',
      data: { captureId, traceId: opts?.traceId },
      opts: {
        jobId: `extract-commitments_${captureId}`,
        removeDependencyOnFailure: true,
        attempts: 5,
        backoff: { type: 'custom' },
      },
    },
  ]

  if (opts?.includeWikiIngest) {
    children.push({
      name: 'wiki-ingest',
      queueName: 'wiki-ingest',
      data: { captureId, traceId: opts?.traceId },
      opts: {
        jobId: `wiki-ingest_${captureId}`,
        removeDependencyOnFailure: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000 },
      },
    })
  }

  return root(children)
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
  /** Pipeline trace ID (UUID v4) for cross-stage correlation in logs and pipeline_events */
  traceId?: string
}
