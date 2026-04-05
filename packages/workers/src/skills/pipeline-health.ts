import { sql } from 'drizzle-orm'
import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import { skills_log } from '@open-brain/shared'
import { logger, PushoverService } from '@open-brain/shared'

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

export interface PipelineHealthResult {
  healthy: boolean
  queues: QueueStats[]
  recentFailures: RecentFailure[]
  stalledByQueue: StalledStats[]
  captureFlowStale: boolean
  alertSent: boolean
  durationMs: number
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
export class PipelineHealthSkill {
  private db: Database
  private queueFactory: QueueFactory
  private pushover: PushoverService

  constructor(opts: {
    db: Database
    /** Production: omit (uses redisConnection). Tests: supply mock factory. */
    queueFactory?: QueueFactory
    /** Redis connection options — used only if queueFactory is not supplied. */
    redisConnection?: ConnectionOptions
    pushover?: PushoverService
  }) {
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()

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
  async execute(options: PipelineHealthOptions = {}): Promise<PipelineHealthResult> {
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

    // Step 5: Log to skills_log
    await this.logToSkillsLog({
      queues,
      recentFailures,
      stalledByQueue,
      captureFlowStale,
      healthy,
      alertSent,
      durationMs,
    })

    logger.info(
      { healthy, queueCount: queues.length, recentFailureCount: recentFailures.length, alertSent, durationMs },
      '[pipeline-health] execution complete',
    )

    return {
      healthy,
      queues,
      recentFailures,
      stalledByQueue,
      captureFlowStale,
      alertSent,
      durationMs,
    }
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
  // Private: pipeline_events failure query
  // ----------------------------------------------------------

  /**
   * Query pipeline_events for 'failed' status entries within the lookback window.
   * Returns the most recent 50 failures (bounded result without unbounded scan).
   */
  private async queryRecentFailures(lookbackMinutes: number): Promise<RecentFailure[]> {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000)

    try {
      const rows = await this.db.execute<{
        capture_id: string
        stage: string
        error: string | null
        created_at: string
      }>(sql`
        SELECT capture_id, stage, error, created_at
        FROM pipeline_events
        WHERE status = 'failed'
          AND created_at >= ${since.toISOString()}::timestamptz
        ORDER BY created_at DESC
        LIMIT 50
      `)
      return rows.rows as RecentFailure[]
    } catch (err) {
      logger.warn({ err }, '[pipeline-health] failed to query pipeline_events — returning empty')
      return []
    }
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
  // Private: capture flow check
  // ----------------------------------------------------------

  /**
   * Check if captures are flowing. Returns true if no capture has been
   * created in the last `hoursThreshold` hours.
   * This detects silent failures where the system is "running" but not processing.
   */
  private async checkCaptureFlow(hoursThreshold: number): Promise<boolean> {
    try {
      const since = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000)
      const rows = await this.db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text as count
        FROM captures
        WHERE created_at >= ${since.toISOString()}::timestamptz
          AND deleted_at IS NULL
      `)
      const count = Number(rows.rows[0]?.count ?? 0)
      if (count === 0) {
        logger.warn({ hoursThreshold }, '[pipeline-health] no captures in recent window')
        return true
      }
      return false
    } catch (err) {
      logger.warn({ err }, '[pipeline-health] failed to check capture flow — assuming OK')
      return false
    }
  }

  // ----------------------------------------------------------
  // Private: capture flow alert suppression
  // ----------------------------------------------------------

  /**
   * Check if a capture-flow-stale alert was already sent within the last N hours.
   * Queries skills_log for pipeline-health entries where output_summary contains
   * both 'captureFlowStale:true' and 'alert:true'.
   */
  private async wasCaptureFlowAlertSentRecently(hours: number): Promise<boolean> {
    try {
      const since = new Date(Date.now() - hours * 60 * 60 * 1000)
      const rows = await this.db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text as count
        FROM skills_log
        WHERE skill_name = 'pipeline-health'
          AND created_at >= ${since.toISOString()}::timestamptz
          AND output_summary LIKE '%captureFlowStale:true%'
          AND output_summary LIKE '%alert:true%'
      `)
      return Number(rows.rows[0]?.count ?? 0) > 0
    } catch (err) {
      logger.warn({ err }, '[pipeline-health] failed to check recent alert history — allowing alert')
      return false
    }
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

  private async logToSkillsLog(params: {
    queues: QueueStats[]
    recentFailures: RecentFailure[]
    stalledByQueue: StalledStats[]
    captureFlowStale: boolean
    healthy: boolean
    alertSent: boolean
    durationMs: number
  }): Promise<void> {
    const totalFailed = params.queues.reduce((sum, q) => sum + q.failed, 0)
    const totalWaiting = params.queues.reduce((sum, q) => sum + q.waiting, 0)
    const totalActive = params.queues.reduce((sum, q) => sum + q.active, 0)
    const totalStalled = params.stalledByQueue.reduce((sum, s) => sum + s.stalledCount, 0)

    const inputSummary = `${params.queues.length} queues checked`
    const outputSummary = [
      `healthy:${params.healthy}`,
      `failed:${totalFailed}`,
      `waiting:${totalWaiting}`,
      `active:${totalActive}`,
      `stalled:${totalStalled}`,
      `recentFailures:${params.recentFailures.length}`,
      `captureFlowStale:${params.captureFlowStale}`,
      `alert:${params.alertSent}`,
    ].join(' | ')

    try {
      await this.db.insert(skills_log).values({
        skill_name: 'pipeline-health',
        capture_id: null,
        input_summary: inputSummary,
        output_summary: outputSummary,
        duration_ms: params.durationMs,
      })
    } catch (err) {
      // skills_log failure is non-fatal
      logger.warn({ err }, '[pipeline-health] failed to write skills_log entry')
    }
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
