import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { pushMetrics } from '../lib/push-metrics.js'
import type { MetricLine } from '../lib/push-metrics.js'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import {
  queryRecentFailures as queryRecentFailuresFromDb,
  checkCaptureFlow as checkCaptureFlowFromDb,
  wasCaptureFlowAlertSentRecently as wasCaptureFlowAlertSentRecentlyFromDb,
} from './pipeline-health-query.js'

// ============================================================
// Types
// ============================================================

export interface QueueStats {
  name: string
  waiting: number
  active: number
  failed: number
  delayed: number
  paused: number
}

export interface RecentFailure {
  capture_id: string
  stage: string
  error: string | null
  created_at: Date | string
}

export interface StalledStats {
  queueName: string
  stalledCount: number
}

export interface PipelineHealthResult extends BaseResult {
  healthy: boolean
  queues: QueueStats[]
  recentFailures: RecentFailure[]
  stalledByQueue: StalledStats[]
  captureFlowStale: boolean
  alertSent: boolean
}

export interface PipelineHealthOptions {
  /**
   * Look back this many minutes for recent pipeline_events failures.
   * Default: 60 minutes.
   */
  failureLookbackMinutes?: number
  /**
   * Alert threshold: send Pushover if any queue's failed count exceeds this.
   * Default: 5.
   */
  failedThreshold?: number
  /**
   * Alert threshold: send Pushover if any queue's waiting count exceeds this.
   * Default: 100.
   */
  waitingThreshold?: number
  /**
   * Alert threshold: send Pushover if stalled jobs are detected (any count > 0).
   * Default: true.
   */
  alertOnStalled?: boolean
}

/**
 * Minimal interface for BullMQ queue operations needed by PipelineHealthSkill.
 * Injected as a factory so tests can supply mock queues without module-level mocking.
 */
export interface QueueHandle {
  getJobCounts(...types: string[]): Promise<Record<string, number>>
  getJobCountByTypes(...types: string[]): Promise<number>
  close(): Promise<void>
}

/**
 * Factory function type that creates a QueueHandle for a given queue name.
 * Production: creates a real BullMQ Queue. Tests: returns mock objects.
 */
export type QueueFactory = (name: string) => QueueHandle

// ============================================================
// Constants
// ============================================================

/**
 * All BullMQ queue names in the Open Brain stack.
 * Keep in sync with packages/workers/src/queues/index.ts.
 */
export const ALL_QUEUE_NAMES = [
  'capture-pipeline',
  'embed-capture',
  'check-triggers',
  'extract-entities',
  'skill-execution',
  'notification',
  'access-stats',
  'daily-sweep',
] as const

const DEFAULT_FAILURE_LOOKBACK_MINUTES = 60
const DEFAULT_FAILED_THRESHOLD = 5
const DEFAULT_WAITING_THRESHOLD = 100

// ============================================================
// Production queue factory
// ============================================================

/**
 * Creates a real BullMQ Queue handle for the given connection options.
 * Used in production; tests inject a mock factory instead.
 */
export function makeRealQueueFactory(connection: ConnectionOptions): QueueFactory {
  return (name: string) => new Queue(name, { connection }) as unknown as QueueHandle
}

// ============================================================
// PipelineHealthSkill
// ============================================================

/**
 * PipelineHealthSkill — checks BullMQ queue stats and recent pipeline_events
 * failures. Fires a Pushover alert if configured thresholds are exceeded.
 *
 * Design decisions:
 * - Queries BullMQ Queue.getJobCounts() for waiting/active/failed/delayed/paused
 * - Queries pipeline_events for recent 'failed' entries in the lookback window
 * - Detects stalled jobs via Queue.getJobCountByTypes('stalled') (falls back to 0
 *   if stalled state is not available)
 * - Alert fires if: failed queue count > threshold, waiting > threshold,
 *   or any stalled jobs detected (alertOnStalled: true)
 * - skills_log entry written on both success and failure
 * - Non-fatal: Redis/DB failures return degraded result, logs warning
 * - QueueFactory injected for testability — tests supply mock queues
 */
/** Constructor options for PipelineHealthSkill. */
export interface PipelineHealthSkillOpts extends BaseSkillOpts {
  /** Production: omit (uses redisConnection). Tests: supply mock factory. */
  queueFactory?: QueueFactory
  /** Redis connection options — used only if queueFactory is not supplied. */
  redisConnection?: ConnectionOptions
}

export class PipelineHealthSkill extends BaseSkill<PipelineHealthOptions, PipelineHealthResult> {
  private queueFactory: QueueFactory

  constructor(opts: PipelineHealthSkillOpts) {
    super('pipeline-health', opts)

    if (opts.queueFactory) {
      this.queueFactory = opts.queueFactory
    } else {
      // Parse REDIS_URL (e.g., redis://redis:6379) if REDIS_HOST is not set
      let connection: ConnectionOptions
      if (opts.redisConnection) {
        connection = opts.redisConnection
      } else if (process.env.REDIS_URL) {
        const url = new URL(process.env.REDIS_URL)
        connection = {
          host: url.hostname || 'localhost',
          port: Number(url.port) || 6379,
          ...(url.password ? { password: url.password } : {}),
        }
      } else {
        connection = {
          host: process.env.REDIS_HOST ?? 'localhost',
          port: Number(process.env.REDIS_PORT ?? 6379),
        }
      }
      this.queueFactory = makeRealQueueFactory(connection)
    }
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Execute the pipeline health check end-to-end.
   *
   * 1. Query BullMQ queue stats for all known queues
   * 2. Query pipeline_events for recent failures
   * 3. Check for stalled jobs
   * 4. Evaluate thresholds — send Pushover if exceeded
   * 5. Log to skills_log
   *
   * Never throws — returns a degraded result on error.
   */
  protected async run(options: PipelineHealthOptions = {}): Promise<PipelineHealthResult> {
    const {
      failureLookbackMinutes = DEFAULT_FAILURE_LOOKBACK_MINUTES,
      failedThreshold = DEFAULT_FAILED_THRESHOLD,
      waitingThreshold = DEFAULT_WAITING_THRESHOLD,
      alertOnStalled = true,
    } = options

    const startMs = Date.now()

    logger.info({ failureLookbackMinutes, failedThreshold, waitingThreshold }, '[pipeline-health] starting execution')

    // Step 1: Query BullMQ queue stats
    const queues = await this.queryQueueStats()

    // Step 2: Query recent pipeline_events failures
    const recentFailures = await this.queryRecentFailures(failureLookbackMinutes)

    // Step 3: Check for stalled jobs
    const stalledByQueue = await this.queryStalledJobs()

    // Step 3.5: Check capture flow (skip during quiet hours)
    let captureFlowStale = false
    const hour = new Date().getHours()
    const isQuietHours = hour >= 0 && hour < 7  // midnight-7am
    if (!isQuietHours) {
      captureFlowStale = await this.checkCaptureFlow(6)  // 6 hours threshold
      // Suppress repeated capture-flow alerts — only alert once per 24 hours
      if (captureFlowStale && await this.wasCaptureFlowAlertSentRecently(24)) {
        logger.info('[pipeline-health] capture flow stale but alert already sent in last 24h — suppressing')
        captureFlowStale = false
      }
    }

    // Step 3.6: Push queue metrics to Pushgateway
    await this.pushQueueMetrics(queues)

    // Step 4: Evaluate thresholds
    const failedQueues = queues.filter(q => q.failed >= failedThreshold)
    const backloggedQueues = queues.filter(q => q.waiting >= waitingThreshold)
    const stalledQueues = alertOnStalled ? stalledByQueue.filter(s => s.stalledCount > 0) : []

    const shouldAlert = failedQueues.length > 0 || backloggedQueues.length > 0 || stalledQueues.length > 0 || captureFlowStale

    const healthy = !shouldAlert && recentFailures.length === 0

    let alertSent = false
    if (shouldAlert) {
      alertSent = await this.sendAlert({
        failedQueues,
        backloggedQueues,
        stalledQueues,
        recentFailures,
        captureFlowStale,
        failedThreshold,
        waitingThreshold,
      })
    }

    const durationMs = Date.now() - startMs

    // Step 5: Build result and log to skills_log
    const result: PipelineHealthResult = {
      healthy,
      queues,
      recentFailures,
      stalledByQueue,
      captureFlowStale,
      alertSent,
      durationMs,
    }

    await this.writeSkillsLog(result)

    logger.info(
      { healthy, queueCount: queues.length, recentFailureCount: recentFailures.length, alertSent, durationMs },
      '[pipeline-health] execution complete',
    )

    return result
  }

  // ----------------------------------------------------------
  // Private: BullMQ queue stats
  // ----------------------------------------------------------

  /**
   * Query job counts for each known queue.
   * Creates a transient queue handle per queue (read-only, no worker registered).
   * Handles connection errors gracefully by returning zeroed stats for that queue.
   */
  private async queryQueueStats(): Promise<QueueStats[]> {
    const results: QueueStats[] = []

    for (const queueName of ALL_QUEUE_NAMES) {
      const queue = this.queueFactory(queueName)
      try {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'failed',
          'delayed',
          'paused',
        )
        results.push({
          name: queueName,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          paused: counts.paused ?? 0,
        })
        logger.debug({ queueName, counts }, '[pipeline-health] queue stats fetched')
      } catch (err) {
        logger.warn({ queueName, err }, '[pipeline-health] failed to fetch queue stats — using zeroes')
        results.push({
          name: queueName,
          waiting: 0,
          active: 0,
          failed: 0,
          delayed: 0,
          paused: 0,
        })
      } finally {
        await queue.close().catch(() => {})
      }
    }

    return results
  }

  // ----------------------------------------------------------
  // Private: pipeline_events failure query (delegated to query file)
  // ----------------------------------------------------------

  private async queryRecentFailures(lookbackMinutes: number): Promise<RecentFailure[]> {
    return queryRecentFailuresFromDb(this.db, lookbackMinutes)
  }

  // ----------------------------------------------------------
  // Private: stalled job detection
  // ----------------------------------------------------------

  /**
   * Check for stalled jobs in each queue.
   *
   * BullMQ marks a job as stalled when the worker does not send a keepalive
   * within the lock duration. getJobCountByTypes('stalled') queries this count.
   */
  private async queryStalledJobs(): Promise<StalledStats[]> {
    const results: StalledStats[] = []

    for (const queueName of ALL_QUEUE_NAMES) {
      const queue = this.queueFactory(queueName)
      try {
        const count = await queue.getJobCountByTypes('stalled')
        if (count > 0) {
          logger.warn({ queueName, stalledCount: count }, '[pipeline-health] stalled jobs detected')
        }
        results.push({ queueName, stalledCount: count })
      } catch (err) {
        // Stalled count unavailable — treat as 0 (non-fatal)
        logger.debug({ queueName, err }, '[pipeline-health] stalled count unavailable')
        results.push({ queueName, stalledCount: 0 })
      } finally {
        await queue.close().catch(() => {})
      }
    }

    return results
  }

  // ----------------------------------------------------------
  // Private: push queue metrics to Pushgateway
  // ----------------------------------------------------------

  /**
   * Push BullMQ queue depth gauges to Prometheus Pushgateway.
   * Metrics: openbrain_queue_waiting, openbrain_queue_active, openbrain_queue_failed,
   * openbrain_queue_delayed per queue. Failures are silently caught.
   */
  private async pushQueueMetrics(queues: QueueStats[]): Promise<void> {
    const metrics: MetricLine[] = []

    for (const q of queues) {
      metrics.push(
        { name: 'openbrain_queue_waiting', value: q.waiting, labels: { queue: q.name }, help: 'Number of waiting jobs per queue', type: 'gauge' },
        { name: 'openbrain_queue_active', value: q.active, labels: { queue: q.name }, help: 'Number of active jobs per queue', type: 'gauge' },
        { name: 'openbrain_queue_failed', value: q.failed, labels: { queue: q.name }, help: 'Number of failed jobs per queue', type: 'gauge' },
        { name: 'openbrain_queue_delayed', value: q.delayed, labels: { queue: q.name }, help: 'Number of delayed jobs per queue', type: 'gauge' },
      )
    }

    await pushMetrics(metrics)
  }

  // ----------------------------------------------------------
  // Private: capture flow check (delegated to query file)
  // ----------------------------------------------------------

  private async checkCaptureFlow(hoursThreshold: number): Promise<boolean> {
    return checkCaptureFlowFromDb(this.db, hoursThreshold)
  }

  // ----------------------------------------------------------
  // Private: capture flow alert suppression (delegated to query file)
  // ----------------------------------------------------------

  private async wasCaptureFlowAlertSentRecently(hours: number): Promise<boolean> {
    return wasCaptureFlowAlertSentRecentlyFromDb(this.db, hours)
  }

  // ----------------------------------------------------------
  // Private: Pushover alert
  // ----------------------------------------------------------

  /**
   * Send a Pushover alert summarizing the health issues detected.
   * Priority 1 (high) — pipeline failures are actionable, not emergency.
   *
   * Returns true if sent successfully, false if Pushover not configured or send failed.
   */
  private async sendAlert(params: {
    failedQueues: QueueStats[]
    backloggedQueues: QueueStats[]
    stalledQueues: StalledStats[]
    recentFailures: RecentFailure[]
    captureFlowStale: boolean
    failedThreshold: number
    waitingThreshold: number
  }): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug('[pipeline-health] Pushover not configured — skipping alert')
      return false
    }

    const lines: string[] = ['Pipeline Health Alert']

    if (params.failedQueues.length > 0) {
      lines.push(
        `Failed jobs (>${params.failedThreshold}): ` +
        params.failedQueues.map(q => `${q.name}=${q.failed}`).join(', '),
      )
    }

    if (params.backloggedQueues.length > 0) {
      lines.push(
        `Backlogged (>${params.waitingThreshold}): ` +
        params.backloggedQueues.map(q => `${q.name}=${q.waiting}`).join(', '),
      )
    }

    if (params.stalledQueues.length > 0) {
      lines.push(
        `Stalled jobs: ` +
        params.stalledQueues.map(s => `${s.queueName}=${s.stalledCount}`).join(', '),
      )
    }

    if (params.recentFailures.length > 0) {
      // Summarize failure stages
      const stageCounts = new Map<string, number>()
      for (const f of params.recentFailures) {
        stageCounts.set(f.stage, (stageCounts.get(f.stage) ?? 0) + 1)
      }
      const stageSummary = Array.from(stageCounts.entries())
        .map(([stage, count]) => `${stage}:${count}`)
        .join(', ')
      lines.push(`Recent failures: ${params.recentFailures.length} (${stageSummary})`)
    }

    if (params.captureFlowStale) {
      lines.push('No captures received in the last 6 hours (during active hours)')
    }

    const message = lines.join('\n')

    try {
      await this.pushover.send({
        title: 'Open Brain: Pipeline Health Alert',
        message,
        priority: 1,
      })
      logger.info('[pipeline-health] Pushover alert sent')
      return true
    } catch (err) {
      logger.warn({ err }, '[pipeline-health] Pushover alert failed — continuing')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: skills_log
  // ----------------------------------------------------------

  private async writeSkillsLog(result: PipelineHealthResult): Promise<void> {
    const totalFailed = result.queues.reduce((sum, q) => sum + q.failed, 0)
    const totalWaiting = result.queues.reduce((sum, q) => sum + q.waiting, 0)
    const totalActive = result.queues.reduce((sum, q) => sum + q.active, 0)
    const totalStalled = result.stalledByQueue.reduce((sum, s) => sum + s.stalledCount, 0)

    const outputSummary = [
      `healthy:${result.healthy}`,
      `failed:${totalFailed}`,
      `waiting:${totalWaiting}`,
      `active:${totalActive}`,
      `stalled:${totalStalled}`,
      `recentFailures:${result.recentFailures.length}`,
      `captureFlowStale:${result.captureFlowStale}`,
      `alert:${result.alertSent}`,
    ].join(' | ')

    await this.logResult(
      result,
      `${result.queues.length} queues checked`,
      outputSummary,
    )
  }
}

// ============================================================
// Skill execution entry point — called by BullMQ skill worker
// ============================================================

/**
 * Top-level function invoked by the skill-execution BullMQ worker.
 *
 * Constructs PipelineHealthSkill with production dependencies (real BullMQ queues
 * via Redis connection from environment) and executes.
 */
export async function executePipelineHealth(
  db: Database,
  options: PipelineHealthOptions = {},
): Promise<PipelineHealthResult> {
  const skill = new PipelineHealthSkill({ db })
  return skill.execute(options)
}
