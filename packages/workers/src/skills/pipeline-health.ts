import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database, PipelineEventStage } from '@open-brain/shared'
import { logger, WORKER_QUEUES, ALL_MONITORED_QUEUES } from '@open-brain/shared'
import { pushMetrics } from '../lib/push-metrics.js'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pushBackupAgeGauge, DEFAULT_BACKUP_MANIFEST_PATH } from '../lib/backup-age.js'
import { ensureHeartbeatBaseline } from '../lib/heartbeat.js'
import { legacyPushEnabled, alertStateEnabled, queueAlertKey } from '../lib/alert-state.js'
import type { MetricLine } from '../lib/push-metrics.js'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import {
  queryRecentFailures as queryRecentFailuresFromDb,
  queryEmbedStall as queryEmbedStallFromDb,
  queryStuckCaptures as queryStuckCapturesFromDb,
  queryPipelineSuccessShare as queryPipelineSuccessShareFromDb,
  querySourceFreshness as querySourceFreshnessFromDb,
  EXPECTED_HEARTBEAT_SOURCES,
  type EmbedStallStats,
  type SourceFreshnessResult,
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
  /** Failed jobs that finished in the last 24 h (the `openbrain_queue_failed_24h` gauge). Null when not counted. */
  failed24h: number | null
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
  /** Keys (`offsite-stale` / `rehearsal-stale`) whose last-success marker is stale or (when required) missing. */
  staleJobMarkers: string[]
  /**
   * Seconds since the latest backup manifest was written, or null when the
   * manifest could not be stat'd (mount absent in dev/CI, or not yet deployed
   * — see IMPLEMENTATION_PLAN.md 7.4/OA-9).
   */
  backupAgeSeconds: number | null
  alertSent: boolean
  /** Live captures with no embedding for more than 2 h (excluding `failed`); null when the query failed. */
  embedStalled: number | null
  /** Sources whose heartbeat is stale (item 3.3); null when freshness was not observed. */
  staleSources: string[] | null
  /** `source:ageDays` for voice/slack/email captures idle over 7 d. Listed, never alerted. */
  quietCaptureSources: string[]
  /** Live captures at a sweepable status for more than 24 h; null when the query failed. */
  stuckCaptures: number | null
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
  /**
   * Failed jobs that finished at or after `sinceMs` (epoch ms): `ZCOUNT
   * bull:<queue>:failed <sinceMs> +inf`. BullMQ scores the failed set by the
   * finish timestamp (moveToFinished-14.lua: `ZADD targetSet timestamp jobId`),
   * so this is an O(log n) count with no job payloads read.
   */
  countFailedSince(sinceMs: number): Promise<number>
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
/** Window of the `openbrain_queue_failed_24h` gauge. */
const FAILED_GAUGE_WINDOW_MS = 24 * 3_600_000
/** A live capture without an embedding for longer than this raises `embed-stall`. */
const EMBED_STALL_HOURS = 2

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

/**
 * Job freshness markers (item 7.3). `offsite-backup.sh` (daily 03:45) and
 * `restore-rehearsal.sh` (Sunday 05:30) write the time of their last SUCCESS to
 * `${backup root}/.offsite-last-success` / `.rehearsal-last-success`. Limits give each
 * job one missed run plus a margin: offsite 48 h, rehearsal 8 days.
 */
const OFFSITE_MARKER = '.offsite-last-success'
const REHEARSAL_MARKER = '.rehearsal-last-success'
const OFFSITE_MAX_AGE_SECONDS = 48 * 3600
const REHEARSAL_MAX_AGE_SECONDS = 8 * 24 * 3600

interface JobMarkerCheck {
  key: 'offsite-stale' | 'rehearsal-stale'
  title: string
  severity: 'critical' | 'warning'
  label: string
  /** Seconds since the last success, or null when the marker is missing/unreadable. */
  ageSeconds: number | null
  maxAgeSeconds: number
  stale: boolean
}

// ============================================================
// Production queue factory
// ============================================================

/**
 * Creates a real BullMQ Queue handle for the given connection options.
 * Used in production; tests inject a mock factory instead.
 */
export function makeRealQueueFactory(connection: ConnectionOptions): QueueFactory {
  return (name: string): QueueHandle => {
    const queue = new Queue(name, { connection })
    return {
      getJobCounts: (...types: string[]) => queue.getJobCounts(...(types as Parameters<Queue['getJobCounts']>)),
      getJobCountByTypes: (...types: string[]) => queue.getJobCountByTypes(...(types as Parameters<Queue['getJobCountByTypes']>)),
      countFailedSince: async (sinceMs: number) => {
        const client = await queue.client
        return client.zcount(queue.toKey('failed'), sinceMs, '+inf')
      },
      close: () => queue.close(),
    }
  }
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
      countRecent: true,
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

    // Step 3.55 (item 3.1): capture-level observations. Each is null when its
    // query failed (not observed: no alert change, no gauge).
    const embedStall = await queryEmbedStallFromDb(this.db, EMBED_STALL_HOURS)
    const stuckCaptures = await queryStuckCapturesFromDb(this.db)
    const successShare7d = await queryPipelineSuccessShareFromDb(this.db, 7)

    // Step 3.56 (item 3.3): per-source heartbeats. Baseline first, so a source
    // with no record starts its clock now and raises nothing on this run.
    // Skipped with the alert-state switch off (rollback path): no app_settings access.
    const sourceFreshness = stateOn ? await this.observeSourceFreshness(new Date()) : null

    // Step 3.6: Push queue metrics to Pushgateway
    await this.pushQueueMetrics(queues, {
      stuck: stuckCaptures,
      unembedded: embedStall?.unembedded ?? null,
      successShare7d,
      sourceFreshness,
    })

    // Step 3.7: Backup dead-man's switch — stat manifest, emit age gauge,
    // and (independently) alert if stale (7.4 / PE-H4 / RC-12 / SA-13 / A131).
    const backupCheck = await this.checkBackupAge()

    // Step 3.75 (item 7.3): offsite + rehearsal last-success markers.
    const jobMarkers = stateOn ? await this.checkJobMarkers() : []

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

    const embedStalled = embedStall?.stalled ?? null
    const healthy =
      !shouldAlert && !stateQueuesBad && recentFailures.length === 0 && !backupCheck.stale && !(embedStalled !== null && embedStalled > 0) &&
      !(sourceFreshness?.sources.some(f => f.stale) ?? false)

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
    if (legacyPush && backupCheck.stale) {
      const backupAlertSent = await this.sendBackupStaleAlert(backupCheck.ageSeconds, backupCheck.maxAgeSeconds)
      alertSent = alertSent || backupAlertSent
    }

    // ADR-0005 alert-state path (no-op when ALERT_STATE_ENABLED=false):
    // independent alerts that fire on change and stay silent while they hold.
    const stateAlertSent = await this.raiseStateAlerts({
      backupCheck,
      jobMarkers,
      queueConditions,
      captureFlowObserved,
      embedStall,
      sourceFreshness,
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
      staleJobMarkers: jobMarkers.filter(m => m.stale).map(m => m.key),
      backupAgeSeconds: backupCheck.ageSeconds,
      alertSent,
      embedStalled,
      staleSources: sourceFreshness ? sourceFreshness.sources.filter(s => s.stale).map(s => s.source) : null,
      stuckCaptures,
      quietCaptureSources: sourceFreshness ? sourceFreshness.captureSources.filter(c => c.quiet).map(c => `${c.source}:${c.ageDays}d`) : [],
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
   * `countRecent`: also count failed jobs finished in the last 6 h and 24 h (ZCOUNT).
   */
  private async queryQueueStats(
    queueNames: readonly string[],
    opts: { failedForWorkerQueuesOnly: boolean; countRecent: boolean },
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
        const now = Date.now()
        const countRecent = countsFailures && opts.countRecent
        const recentFailed = countRecent
          ? await this.countFailedSince(queue, queueName, now - RECENT_FAILED_WINDOW_MS)
          : null
        const failed24h = countRecent
          ? await this.countFailedSince(queue, queueName, now - FAILED_GAUGE_WINDOW_MS)
          : null
        results.push({
          name: queueName,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: countsFailures ? (counts.failed ?? 0) : 0,
          delayed: counts.delayed ?? 0,
          paused: counts.paused ?? 0,
          recentFailed,
          failed24h,
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
          failed24h: null,
        })
      } finally {
        await queue.close().catch(() => {})
      }
    }

    return results
  }

  /**
   * Failed jobs of one queue that finished at or after `sinceMs`, via one
   * `ZCOUNT` on the failed set (scored by finish time). Returns null when the
   * count fails: the condition is then not observed and its alert is held, not
   * falsely resolved.
   */
  private async countFailedSince(queue: QueueHandle, queueName: string, sinceMs: number): Promise<number | null> {
    try {
      return await queue.countFailedSince(sinceMs)
    } catch (err) {
      logger.warn({ queueName, err }, '[pipeline-health] failed-job count failed — queue failure alert held this run')
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
      countRecent: false,
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
  private async pushQueueMetrics(
    queues: QueueStats[],
    capture: { stuck: number | null; unembedded: number | null; successShare7d: number | null; sourceFreshness: SourceFreshnessResult | null },
  ): Promise<void> {
    const metrics: MetricLine[] = []

    for (const q of queues) {
      metrics.push(
        { name: 'openbrain_queue_waiting', value: q.waiting, labels: { queue: q.name }, help: 'Number of waiting jobs per queue', type: 'gauge' },
        { name: 'openbrain_queue_active', value: q.active, labels: { queue: q.name }, help: 'Number of active jobs per queue', type: 'gauge' },
        { name: 'openbrain_queue_failed', value: q.failed, labels: { queue: q.name }, help: 'Number of failed jobs per queue', type: 'gauge' },
        { name: 'openbrain_queue_delayed', value: q.delayed, labels: { queue: q.name }, help: 'Number of delayed jobs per queue', type: 'gauge' },
      )
      if (q.failed24h !== null) {
        metrics.push({
          name: 'openbrain_queue_failed_24h', value: q.failed24h, labels: { queue: q.name },
          help: 'Jobs that failed in the last 24 hours per queue', type: 'gauge',
        })
      }
    }

    if (capture.stuck !== null) {
      metrics.push({ name: 'openbrain_captures_stuck', value: capture.stuck, help: 'Live captures at a sweepable status for more than 24 hours', type: 'gauge' })
    }
    if (capture.unembedded !== null) {
      metrics.push({ name: 'openbrain_captures_unembedded', value: capture.unembedded, help: 'Live captures with no embedding', type: 'gauge' })
    }
    if (capture.successShare7d !== null) {
      metrics.push({ name: 'openbrain_pipeline_success_share_7d', value: capture.successShare7d, help: 'Share of captures from the last 7 days that reached complete', type: 'gauge' })
    }

    for (const f of capture.sourceFreshness?.sources ?? []) {
      if (f.ageSeconds === null) continue
      metrics.push({
        name: 'openbrain_source_last_success_seconds', value: f.ageSeconds, labels: { source: f.source },
        help: 'Seconds since the source last reported a successful run', type: 'gauge',
      })
    }

    await pushMetrics(metrics)
  }

  /**
   * Item 3.3: write baselines for expected sources that have no heartbeat, then
   * read freshness. Never throws; null = not observed (open alerts are held).
   */
  private async observeSourceFreshness(now: Date): Promise<SourceFreshnessResult | null> {
    try {
      await ensureHeartbeatBaseline(this.db, EXPECTED_HEARTBEAT_SOURCES, now)
    } catch (err) {
      logger.warn({ err }, '[pipeline-health] heartbeat baseline failed')
    }
    return querySourceFreshnessFromDb(this.db, now)
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
      // Fail closed in production (item 4.2): with BACKUP_MANIFEST_REQUIRED=true an
      // unreadable manifest is itself the failure — a missing mount, a bad
      // permission or a broken symlink must not look like "no news is good news".
      // Unset/false keeps the local-dev and CI skip (and the f341ca6 behaviour).
      if (process.env.BACKUP_MANIFEST_REQUIRED === 'true') {
        logger.warn(
          { manifestPath },
          '[pipeline-health] backup manifest unreadable and BACKUP_MANIFEST_REQUIRED=true — treating as stale',
        )
        return { ageSeconds: null, stale: true, maxAgeSeconds }
      }
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
  // Private: offsite / rehearsal last-success markers (item 7.3)
  // ----------------------------------------------------------

  /**
   * Read the two last-success markers through the backup mount. The root is
   * `BACKUP_ROOT` when set, else the grandparent of `BACKUP_LATEST_PATH`
   * (`<root>/latest/manifest.json`): production mounts `<root>` at its own absolute
   * path and already sets `BACKUP_LATEST_PATH`, so no new compose variable is needed
   * and the markers can never be read from a different directory than the manifest.
   *
   * A missing/unparseable marker is a failure only with `BACKUP_MANIFEST_REQUIRED=true`
   * (same fail-closed rule as the manifest); otherwise the check is skipped and the
   * alert is neither raised nor resolved. Never throws.
   */
  private async checkJobMarkers(): Promise<JobMarkerCheck[]> {
    const manifestPath = process.env.BACKUP_LATEST_PATH ?? DEFAULT_BACKUP_MANIFEST_PATH
    const root = process.env.BACKUP_ROOT || dirname(dirname(manifestPath))
    const required = process.env.BACKUP_MANIFEST_REQUIRED === 'true'
    const specs: Array<Omit<JobMarkerCheck, 'ageSeconds' | 'stale'> & { file: string }> = [
      { key: 'offsite-stale', title: 'Offsite Backup Stale', severity: 'critical', label: 'offsite backup', file: OFFSITE_MARKER, maxAgeSeconds: OFFSITE_MAX_AGE_SECONDS },
      { key: 'rehearsal-stale', title: 'Restore Rehearsal Stale', severity: 'warning', label: 'restore rehearsal', file: REHEARSAL_MARKER, maxAgeSeconds: REHEARSAL_MAX_AGE_SECONDS },
    ]
    const out: JobMarkerCheck[] = []
    for (const { file, ...spec } of specs) {
      const path = `${root.replace(/\/+$/, '')}/${file}`
      let ageSeconds: number | null = null
      try {
        const ms = Date.parse((await readFile(path, 'utf8')).trim())
        if (Number.isFinite(ms)) ageSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
      } catch (err) {
        logger.debug({ err, path }, '[pipeline-health] job marker unreadable')
      }
      if (ageSeconds === null) {
        if (!required) continue // not observed: skip, hold any open alert
        out.push({ ...spec, ageSeconds: null, stale: true })
      } else {
        out.push({ ...spec, ageSeconds, stale: ageSeconds > spec.maxAgeSeconds })
      }
    }
    return out
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
  private async sendBackupStaleAlert(ageSeconds: number | null, maxAgeSeconds: number): Promise<boolean> {
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
    jobMarkers: JobMarkerCheck[]
    queueConditions: QueueCondition[]
    captureFlowObserved: boolean | null
    embedStall: EmbedStallStats | null
    sourceFreshness: SourceFreshnessResult | null
  }): Promise<boolean> {
    let sent = false

    if (p.backupCheck.ageSeconds !== null || p.backupCheck.stale) {
      const r = await this.raiseAlert({
        key: 'backup-stale',
        severity: 'critical',
        bad: p.backupCheck.stale,
        title: 'Backup Stale',
        message: p.backupCheck.stale
          ? backupStaleMessage(p.backupCheck.ageSeconds, p.backupCheck.maxAgeSeconds)
          : backupAgeLine(p.backupCheck.ageSeconds ?? 0, p.backupCheck.maxAgeSeconds),
      })
      sent = sent || r.sent
    }

    for (const m of p.jobMarkers) {
      const r = await this.raiseAlert({
        key: m.key,
        severity: m.severity,
        bad: m.stale,
        title: m.title,
        message: jobMarkerMessage(m),
      })
      sent = sent || r.sent
    }

    for (const c of p.queueConditions) {
      const r = await this.raiseAlert({ key: c.key, severity: 'warning', bad: c.bad, title: c.title, message: c.message })
      sent = sent || r.sent
    }

    if (p.embedStall !== null) {
      const e = p.embedStall
      const bad = e.stalled > 0
      const r = await this.raiseAlert({
        key: 'embed-stall',
        severity: 'critical',
        bad,
        title: 'Embeddings Stalled',
        message: bad ? embedStallMessage(e) : 'No captures are waiting on an embedding for more than 2 hours.',
      })
      sent = sent || r.sent
    }

    // One alert per source (item 3.3). Sources are observed or absent, never guessed.
    for (const f of p.sourceFreshness?.sources ?? []) {
      const r = await this.raiseAlert({
        key: `source-stale:${f.source}`,
        severity: 'warning',
        bad: f.stale,
        title: `Source Stale: ${f.source}`,
        message: f.stale ? `${f.source}: ${f.reason}.` : `${f.source}: last success ${f.lastSuccessAt ?? 'unknown'}.`,
      })
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
      `embedStalled:${result.embedStalled ?? 'n/a'}`,
      `stuckCaptures:${result.stuckCaptures ?? 'n/a'}`,
      `staleSources:${result.staleSources === null ? 'n/a' : result.staleSources.length > 0 ? result.staleSources.join(',') : 'none'}`,
      ...(result.quietCaptureSources.length > 0 ? [`quietSources:${result.quietCaptureSources.join(',')}`] : []),
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
      out.push({
        key: queueAlertKey('failed', q.name),
        bad: q.recentFailed >= t.failedThreshold,
        title: `Queue Failures: ${q.name}`,
        message: `${q.name}: ${q.recentFailed} failed jobs in the last ${windowHours} h (threshold: ${t.failedThreshold}).`,
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

function embedStallMessage(e: EmbedStallStats): string {
  const oldest = e.oldestStalledAt ? `oldest created ${e.oldestStalledAt.toISOString()}` : 'oldest unknown'
  const last = e.newestEmbeddedAt ? `last embedding activity ${e.newestEmbeddedAt.toISOString()}` : 'no embedding activity found'
  return (
    `${e.stalled} live capture(s) have had no embedding for more than ${EMBED_STALL_HOURS} h (${oldest}; ${last}).\n` +
    'Check the OpenAI key and credits, then the embed-capture queue. See docs/runbooks/pipeline-alert.md.'
  )
}

function backupAgeLine(ageSeconds: number, maxAgeSeconds: number): string {
  const ageHours = (ageSeconds / 3600).toFixed(1)
  const maxAgeHours = (maxAgeSeconds / 3600).toFixed(1)
  return `Backup manifest is ${ageHours}h old (threshold: ${maxAgeHours}h).`
}

function jobMarkerMessage(m: JobMarkerCheck): string {
  if (m.ageSeconds === null) {
    return `Alert: ${m.label} last-success marker is missing or unreadable (BACKUP_MANIFEST_REQUIRED=true). See docs/runbooks/backup-alert.md.`
  }
  const hours = Math.floor(m.ageSeconds / 3600)
  const limit = Math.floor(m.maxAgeSeconds / 3600)
  return m.stale
    ? `Alert: last successful ${m.label} was ${hours}h ago (limit ${limit}h). Check its cron log and .env.secrets readability in cron context. See docs/runbooks/backup-alert.md.`
    : `Last successful ${m.label} was ${hours}h ago (limit ${limit}h).`
}

function backupStaleMessage(ageSeconds: number | null, maxAgeSeconds: number): string {
  const first =
    ageSeconds === null
      ? 'Alert: backup manifest unreadable. The file is missing or cannot be read from the workers container ' +
        '(BACKUP_MANIFEST_REQUIRED=true).'
      : backupAgeLine(ageSeconds, maxAgeSeconds)
  return (
    `${first}\n` +
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
