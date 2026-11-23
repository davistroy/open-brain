import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database, PipelineEventStage } from '@open-brain/shared'
import { logger, WORKER_QUEUES, ALL_MONITORED_QUEUES } from '@open-brain/shared'
import { pushMetrics } from '../lib/push-metrics.js'
import { pushBackupAgeGauge, DEFAULT_BACKUP_MANIFEST_PATH } from '../lib/backup-age.js'
import { legacyPushEnabled, alertStateEnabled, queueAlertKey } from '../lib/alert-state.js'
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
  /**
   * Failed jobs that finished in the last RECENT_FAILED_WINDOW_MS (6 h, the
   * pipeline-health interval). The alert-state path alerts on this, not on
   * `failed` (the retained total: flow jobs are kept forever). Null when not
   * counted: alert-state path off, not a worker queue, or the scan failed.
   */
  recentFailed: number | null
}

export interface RecentFailure {
  capture_id: string
  stage: PipelineEventStage
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
  /**
   * True when the latest backup manifest (mtime of BACKUP_LATEST_PATH) is
   * older than the configured max age — the backup dead-man's switch (7.4).
   * Always false when the manifest is absent/unreadable (graceful skip).
   */
  backupStale: boolean
  /**
   * Seconds since the latest backup manifest was written, or null when the
   * manifest could not be stat'd (mount absent in dev/CI, or not yet deployed
   * — see IMPLEMENTATION_PLAN.md 7.4/OA-9).
   */
  backupAgeSeconds: number | null
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
  /** BullMQ `Queue.getJobs`: for `failed`, newest first (sorted set scored by finish time). */
  getJobs(types: string[], start?: number, end?: number, asc?: boolean): Promise<Array<{ finishedOn?: number } | undefined>>
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

const WORKER_QUEUE_SET: ReadonlySet<string> = new Set(WORKER_QUEUES)
const isWorkerQueue = (name: string): boolean => WORKER_QUEUE_SET.has(name)

/**
 * The queue list of the LEGACY direct push, frozen at commit f341ca6
 * (`ALL_QUEUE_NAMES` there). The legacy path reads only these queues, with the
 * f341ca6 semantics (retained failed count for every listed queue), so the
 * rollback (ALERT_STATE_ENABLED=false) and the parallel week push exactly as
 * before and never on a queue that f341ca6 did not read (e.g. the retained
 * failures of the `ingest-root` flow queue). The alert-state path uses the
 * shared registry (ALL_MONITORED_QUEUES). Delete with the legacy path.
 */
export const LEGACY_MONITORED_QUEUES = [
  'capture-pipeline',
  'embed-capture',
  'check-triggers',
  'extract-entities',
  'skill-execution',
  'notification',
  'access-stats',
  'daily-sweep',
] as const

/** Recent-failure window: the pipeline-health interval (scheduler cron `0 0,6,12,18 * * *`). */
const RECENT_FAILED_WINDOW_MS = 6 * 3_600_000
/** Failed-job scan page size and bound (newest jobs only; the count saturates at the bound). */
const RECENT_FAILED_PAGE = 100
const RECENT_FAILED_SCAN_MAX = 1000

const DEFAULT_FAILURE_LOOKBACK_MINUTES = 60
const DEFAULT_FAILED_THRESHOLD = 5
const DEFAULT_WAITING_THRESHOLD = 100

/**
 * Backup dead-man's switch (7.4 / PE-H4 / RC-12 / SA-13 / A131).
 * Default path matches the docker-compose.yml workers ro-mount of the host
 * `${BACKUP_ROOT}/latest` symlink target at /backup-latest.
 * Default max age (93600s = 26h) mirrors config/prometheus/alerts/backup.yml
 * (backup.sh runs daily; 26h = one full day + a 2h grace margin).
 */
const DEFAULT_BACKUP_MAX_AGE_SECONDS = 93600

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
 * - Legacy direct push: LEGACY_MONITORED_QUEUES (f341ca6), retained failed
 *   count. Alert-state path: the registry, one key per queue and condition,
 *   failed = jobs finished in the last 6 h.
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

    const legacyPush = legacyPushEnabled()
    const stateOn = alertStateEnabled()

    // Step 1: Query BullMQ queue stats for the registry. The alert-state path
    // also counts each worker queue's failures in the last 6 h.
    const queues = await this.queryQueueStats(ALL_MONITORED_QUEUES, {
      failedForWorkerQueuesOnly: true,
      recentFailedSinceMs: stateOn ? startMs - RECENT_FAILED_WINDOW_MS : null,
    })

    // Step 2: Query recent pipeline_events failures
    const recentFailures = await this.queryRecentFailures(failureLookbackMinutes)

    // Step 3: Check for stalled jobs
    const stalledByQueue = await this.queryStalledJobs(WORKER_QUEUES)

    // Step 3.5: Check capture flow (skip during quiet hours)
    let captureFlowStale = false
    // Raw observation for the alert-state path; null = not observed (quiet hours).
    let captureFlowObserved: boolean | null = null
    const hour = new Date().getHours()
    const isQuietHours = hour >= 0 && hour < 7  // midnight-7am
    if (!isQuietHours) {
      captureFlowStale = await this.checkCaptureFlow(6)  // 6 hours threshold
      captureFlowObserved = captureFlowStale
      // Suppress repeated capture-flow alerts — only alert once per 24 hours.
      // Legacy-path dedup only: the alert-state path dedups on its own state.
      if (captureFlowStale && legacyPush && await this.wasCaptureFlowAlertSentRecently(24)) {
        logger.info('[pipeline-health] capture flow stale but alert already sent in last 24h — suppressing')
        captureFlowStale = false
      }
    }

    // Step 3.6: Push queue metrics to Pushgateway
    await this.pushQueueMetrics(queues)

    // Step 3.7: Backup dead-man's switch — stat manifest, emit age gauge,
    // and (independently) alert if stale (7.4 / PE-H4 / RC-12 / SA-13 / A131).
    const backupCheck = await this.checkBackupAge()

    // Step 4a: Evaluate thresholds for the legacy direct push — the exact
    // f341ca6 queue list and semantics (LEGACY_MONITORED_QUEUES).
    const thresholds = { failedThreshold, waitingThreshold, alertOnStalled }
    const legacy = legacyPush
      ? await this.evaluateLegacyQueues(thresholds)
      : { failedQueues: [], backloggedQueues: [], stalledQueues: [] }
    const legacyQueuesBad =
      legacy.failedQueues.length > 0 || legacy.backloggedQueues.length > 0 || legacy.stalledQueues.length > 0
    const shouldAlert = legacyQueuesBad || captureFlowStale

    // Step 4b: Alert-state queue conditions — one key per queue and kind, with
    // failures counted over the last 6 h only.
    const queueConditions = stateOn ? buildQueueConditions(queues, stalledByQueue, thresholds) : []
    const stateQueuesBad = queueConditions.some(c => c.bad)

    const healthy = !shouldAlert && !stateQueuesBad && recentFailures.length === 0 && !backupCheck.stale

    let alertSent = false
    if (shouldAlert && legacyPush) {
      alertSent = await this.sendAlert({
        failedQueues: legacy.failedQueues,
        backloggedQueues: legacy.backloggedQueues,
        stalledQueues: legacy.stalledQueues,
        recentFailures,
        captureFlowStale,
        failedThreshold,
        waitingThreshold,
      })
    }

    // Backup-stale alert is deliberately independent of sendAlert() above —
    // it fires on its own condition and must not be folded into the generic
    // queue/capture-flow message (this is the PLT-H2 redundancy path; the
    // Prometheus BackupStale rule's delivery via the shared stack is unproven).
    if (legacyPush && backupCheck.stale && backupCheck.ageSeconds !== null) {
      const backupAlertSent = await this.sendBackupStaleAlert(backupCheck.ageSeconds, backupCheck.maxAgeSeconds)
      alertSent = alertSent || backupAlertSent
    }

    // ADR-0005 alert-state path (no-op when ALERT_STATE_ENABLED=false):
    // independent alerts that fire on change and stay silent while they hold.
    const stateAlertSent = await this.raiseStateAlerts({
      backupCheck,
      queueConditions,
      captureFlowObserved,
    })
    alertSent = alertSent || stateAlertSent

    const durationMs = Date.now() - startMs

    // Step 5: Build result and log to skills_log
    const result: PipelineHealthResult = {
      healthy,
      queues,
      recentFailures,
      stalledByQueue,
      captureFlowStale,
      backupStale: backupCheck.stale,
      backupAgeSeconds: backupCheck.ageSeconds,
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
   * Query job counts for each named queue.
   * Creates a transient queue handle per queue (read-only, no worker registered).
   * Handles connection errors gracefully by returning zeroed stats for that queue.
   *
   * `failedForWorkerQueuesOnly`: the registry read counts failures for
   * WORKER_QUEUES only; the legacy read (f341ca6) counts them for every queue.
   * `recentFailedSinceMs`: when set, also count failed jobs finished since then.
   */
  private async queryQueueStats(
    queueNames: readonly string[],
    opts: { failedForWorkerQueuesOnly: boolean; recentFailedSinceMs: number | null },
  ): Promise<QueueStats[]> {
    const results: QueueStats[] = []

    for (const queueName of queueNames) {
      const queue = this.queueFactory(queueName)
      try {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'failed',
          'delayed',
          'paused',
        )
        // Failure counts read WORKER_QUEUES only: a producer-only queue has no
        // consumer, so a failed count there is not a pipeline failure signal.
        const countsFailures = !opts.failedForWorkerQueuesOnly || isWorkerQueue(queueName)
        const recentFailed = countsFailures && opts.recentFailedSinceMs !== null
          ? await this.countRecentFailed(queue, queueName, opts.recentFailedSinceMs)
          : null
        results.push({
          name: queueName,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: countsFailures ? (counts.failed ?? 0) : 0,
          delayed: counts.delayed ?? 0,
          paused: counts.paused ?? 0,
          recentFailed,
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
          recentFailed: null,
        })
      } finally {
        await queue.close().catch(() => {})
      }
    }

    return results
  }

  /**
   * Failed jobs of one queue that finished at or after `sinceMs`. BullMQ keeps
   * the failed set as a sorted set scored by finish time and `getJobs` returns
   * it newest first, so the scan pages from the newest job and stops at the
   * first page that reaches past the window. Bounded to the newest
   * RECENT_FAILED_SCAN_MAX jobs (the count saturates there, far above any
   * threshold). Returns null when the scan fails: the condition is then not
   * observed and its alert is held, not falsely resolved.
   */
  private async countRecentFailed(queue: QueueHandle, queueName: string, sinceMs: number): Promise<number | null> {
    let count = 0
    try {
      for (let start = 0; start < RECENT_FAILED_SCAN_MAX; start += RECENT_FAILED_PAGE) {
        const jobs = await queue.getJobs(['failed'], start, start + RECENT_FAILED_PAGE - 1)
        let reachedOlder = false
        for (const job of jobs) {
          const finishedOn = job?.finishedOn
          if (finishedOn === undefined) continue
          if (finishedOn >= sinceMs) count++
          else reachedOlder = true
        }
        if (reachedOlder || jobs.length < RECENT_FAILED_PAGE) break
      }
      return count
    } catch (err) {
      logger.warn({ queueName, err }, '[pipeline-health] failed-job scan failed — queue failure alert held this run')
      return null
    }
  }

  /**
   * Legacy direct-push evaluation: LEGACY_MONITORED_QUEUES with the f341ca6
   * semantics (retained failed count, stalled count per listed queue).
   */
  private async evaluateLegacyQueues(t: QueueThresholds): Promise<{
    failedQueues: QueueStats[]
    backloggedQueues: QueueStats[]
    stalledQueues: StalledStats[]
  }> {
    const stats = await this.queryQueueStats(LEGACY_MONITORED_QUEUES, {
      failedForWorkerQueuesOnly: false,
      recentFailedSinceMs: null,
    })
    const stalled = await this.queryStalledJobs(LEGACY_MONITORED_QUEUES)
    return {
      failedQueues: stats.filter(q => q.failed >= t.failedThreshold),
      backloggedQueues: stats.filter(q => q.waiting >= t.waitingThreshold),
      stalledQueues: t.alertOnStalled ? stalled.filter(s => s.stalledCount > 0) : [],
    }
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
  private async queryStalledJobs(queueNames: readonly string[]): Promise<StalledStats[]> {
    const results: StalledStats[] = []

    for (const queueName of queueNames) {
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
  // Private: backup dead-man's switch
  // ----------------------------------------------------------

  /**
   * Stat the latest backup manifest (read-only bind mount from the host
   * `${BACKUP_ROOT}/latest` symlink — docker-compose.yml workers volumes,
   * batched into the deferred compose window, OA-9) and emit an
   * `openbrain_backup_age_seconds` gauge to Pushgateway.
   *
   * GRACEFUL: if the manifest is absent or unreadable (mount not deployed
   * yet, local dev, CI), this logs at debug and returns a no-op result —
   * never throws. The gauge push itself also never throws (push-metrics
   * swallows its own errors).
   */
  private async checkBackupAge(): Promise<{ ageSeconds: number | null; stale: boolean; maxAgeSeconds: number }> {
    const manifestPath = process.env.BACKUP_LATEST_PATH ?? DEFAULT_BACKUP_MANIFEST_PATH
    const envMaxAge = process.env.BACKUP_MAX_AGE_SECONDS ? Number(process.env.BACKUP_MAX_AGE_SECONDS) : NaN
    const maxAgeSeconds = Number.isFinite(envMaxAge) && envMaxAge > 0 ? envMaxAge : DEFAULT_BACKUP_MAX_AGE_SECONDS

    // Stat the manifest + push the openbrain_backup_age_seconds gauge (shared
    // helper — container-health re-pushes it every 15m so it survives a
    // Pushgateway restart, #309). Returns null when the manifest is absent.
    const ageSeconds = await pushBackupAgeGauge(manifestPath)
    if (ageSeconds === null) {
      return { ageSeconds: null, stale: false, maxAgeSeconds }
    }

    const stale = ageSeconds > maxAgeSeconds
    if (stale) {
      logger.warn(
        { ageSeconds, maxAgeSeconds, manifestPath },
        "[pipeline-health] backup manifest stale — dead man's switch triggered",
      )
    }

    return { ageSeconds, stale, maxAgeSeconds }
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

    const lines: string[] = ['Pipeline Health Alert', ...queueProblemLines(params)]

    if (params.captureFlowStale) {
      lines.push(CAPTURE_FLOW_STALE_LINE)
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

  /**
   * Send a Pushover alert for a stale backup manifest — the dead-man's-switch
   * redundancy path (7.4). Independent of the Prometheus `BackupStale` rule
   * (PLT-H2: shared-stack alert delivery is unproven) — this fires directly
   * from the app layer, same pattern/priority as sendAlert() above.
   *
   * Returns true if sent successfully, false if Pushover not configured or send failed.
   */
  private async sendBackupStaleAlert(ageSeconds: number, maxAgeSeconds: number): Promise<boolean> {
    if (!this.pushover.isConfigured) {
      logger.debug("[pipeline-health] Pushover not configured — skipping backup-stale alert")
      return false
    }

    const message = backupStaleMessage(ageSeconds, maxAgeSeconds)

    try {
      await this.pushover.send({
        title: 'Open Brain: Backup Stale',
        message,
        priority: 1,
      })
      logger.info({ ageSeconds, maxAgeSeconds }, '[pipeline-health] backup-stale Pushover alert sent')
      return true
    } catch (err) {
      logger.warn({ err }, '[pipeline-health] backup-stale Pushover alert failed — continuing')
      return false
    }
  }

  /**
   * ADR-0005 path: one `raiseAlert` per condition, each with its own state key,
   * so a backup alert, one queue's alert and another queue's alert never mask
   * each other. A condition that was not observed this run (absent backup
   * manifest; capture flow in quiet hours; a failed-job scan error) is not
   * reported, so an open alert is held instead of falsely resolved. Returns
   * true when any message was delivered.
   */
  private async raiseStateAlerts(p: {
    backupCheck: { ageSeconds: number | null; stale: boolean; maxAgeSeconds: number }
    queueConditions: QueueCondition[]
    captureFlowObserved: boolean | null
  }): Promise<boolean> {
    let sent = false

    if (p.backupCheck.ageSeconds !== null) {
      const r = await this.raiseAlert({
        key: 'backup-stale',
        severity: 'critical',
        bad: p.backupCheck.stale,
        title: 'Backup Stale',
        message: p.backupCheck.stale
          ? backupStaleMessage(p.backupCheck.ageSeconds, p.backupCheck.maxAgeSeconds)
          : backupAgeLine(p.backupCheck.ageSeconds, p.backupCheck.maxAgeSeconds),
      })
      sent = sent || r.sent
    }

    for (const c of p.queueConditions) {
      const r = await this.raiseAlert({ key: c.key, severity: 'warning', bad: c.bad, title: c.title, message: c.message })
      sent = sent || r.sent
    }

    if (p.captureFlowObserved !== null) {
      const r = await this.raiseAlert({
        key: 'capture-flow',
        severity: 'warning',
        bad: p.captureFlowObserved,
        title: 'Capture Flow Stale',
        message: p.captureFlowObserved ? CAPTURE_FLOW_STALE_LINE : 'Captures received in the last 6 hours.',
      })
      sent = sent || r.sent
    }

    return sent
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
      `backupStale:${result.backupStale}`,
      `backupAgeSeconds:${result.backupAgeSeconds ?? 'n/a'}`,
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
// Alert-state queue conditions (one key per queue and kind)
// ============================================================

interface QueueThresholds {
  failedThreshold: number
  waitingThreshold: number
  alertOnStalled: boolean
}

interface QueueCondition {
  key: string
  bad: boolean
  title: string
  message: string
}

/**
 * `queue-failed:<q>` (failures finished in the last 6 h, worker queues, only
 * when counted), `queue-backlog:<q>` (waiting, every registry queue) and
 * `queue-stalled:<q>` (worker queues). Threshold semantics match the legacy
 * path: failed/waiting `>=` threshold, stalled `> 0` when alertOnStalled.
 */
function buildQueueConditions(queues: QueueStats[], stalled: StalledStats[], t: QueueThresholds): QueueCondition[] {
  const windowHours = RECENT_FAILED_WINDOW_MS / 3_600_000
  const out: QueueCondition[] = []
  for (const q of queues) {
    if (q.recentFailed !== null) {
      const n = q.recentFailed >= RECENT_FAILED_SCAN_MAX ? `${RECENT_FAILED_SCAN_MAX}+` : String(q.recentFailed)
      out.push({
        key: queueAlertKey('failed', q.name),
        bad: q.recentFailed >= t.failedThreshold,
        title: `Queue Failures: ${q.name}`,
        message: `${q.name}: ${n} failed jobs in the last ${windowHours} h (threshold: ${t.failedThreshold}).`,
      })
    }
    out.push({
      key: queueAlertKey('backlog', q.name),
      bad: q.waiting >= t.waitingThreshold,
      title: `Queue Backlog: ${q.name}`,
      message: `${q.name}: ${q.waiting} waiting jobs (threshold: ${t.waitingThreshold}).`,
    })
  }
  for (const s of stalled) {
    out.push({
      key: queueAlertKey('stalled', s.queueName),
      bad: t.alertOnStalled && s.stalledCount > 0,
      title: `Queue Stalled: ${s.queueName}`,
      message: `${s.queueName}: ${s.stalledCount} stalled jobs.`,
    })
  }
  return out
}

// ============================================================
// Message builders (shared by the legacy pushes and the alert-state path)
// ============================================================

const CAPTURE_FLOW_STALE_LINE = 'No captures received in the last 6 hours (during active hours)'

function backupAgeLine(ageSeconds: number, maxAgeSeconds: number): string {
  const ageHours = (ageSeconds / 3600).toFixed(1)
  const maxAgeHours = (maxAgeSeconds / 3600).toFixed(1)
  return `Backup manifest is ${ageHours}h old (threshold: ${maxAgeHours}h).`
}

function backupStaleMessage(ageSeconds: number, maxAgeSeconds: number): string {
  return (
    `${backupAgeLine(ageSeconds, maxAgeSeconds)}\n` +
    'Check the offsite-backup/restore-rehearsal cron logs and .env.secrets ' +
    'readability in cron context. See docs/runbooks/backup-alert.md.'
  )
}

/** Failed / backlogged / stalled queue lines plus the recent-failure stage summary. */
function queueProblemLines(params: {
  failedQueues: QueueStats[]
  backloggedQueues: QueueStats[]
  stalledQueues: StalledStats[]
  recentFailures: RecentFailure[]
  failedThreshold: number
  waitingThreshold: number
}): string[] {
  const lines: string[] = []

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

  return lines
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
