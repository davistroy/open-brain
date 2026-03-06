import type { Queue } from 'bullmq'
import { logger } from '../lib/logger.js'

/**
 * Job data for the capture-pipeline BullMQ queue.
 * Mirrors CapturePipelineJobData in @open-brain/workers — kept local to
 * avoid a circular workspace dependency (core-api → workers → shared → core-api).
 */
interface CapturePipelineJobData {
  captureId: string
  pipelineName?: string
}

export interface PipelineQueueHealth {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

/**
 * PipelineService wraps the BullMQ capture-pipeline queue.
 *
 * Responsibilities:
 *   - enqueue(captureId, pipelineName): adds a capture-pipeline job with
 *     jobId=captureId for idempotency (BullMQ deduplicates by jobId)
 *   - getHealth(): returns queue depth counters for monitoring
 */
export class PipelineService {
  private queue: Queue<CapturePipelineJobData>

  constructor(queue: Queue<CapturePipelineJobData>) {
    this.queue = queue
  }

  /**
   * Enqueues a capture-pipeline job for the given capture.
   *
   * Uses jobId = `pipeline:${captureId}` so duplicate enqueue calls
   * (e.g., from retry or daily sweep) are safely deduplicated by BullMQ.
   *
   * @param captureId   UUID of the capture to process
   * @param pipelineName  Pipeline to use (default: 'default')
   */
  async enqueue(captureId: string, pipelineName = 'default'): Promise<void> {
    await this.queue.add(
      'capture-pipeline',
      { captureId, pipelineName },
      { jobId: `pipeline:${captureId}` },
    )
    logger.info({ captureId, pipelineName }, '[pipeline] job enqueued')
  }

  /**
   * Returns queue health counters for use by /admin/queues and stats endpoint.
   * Returns zeros if the Redis connection is unavailable (non-critical path).
   */
  async getHealth(): Promise<PipelineQueueHealth> {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.queue.getWaitingCount(),
        this.queue.getActiveCount(),
        this.queue.getCompletedCount(),
        this.queue.getFailedCount(),
        this.queue.getDelayedCount(),
      ])
      return { waiting, active, completed, failed, delayed }
    } catch (err) {
      logger.warn({ err }, '[pipeline] getHealth failed — returning zeros')
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
    }
  }
}
