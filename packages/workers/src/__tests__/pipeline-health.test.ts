import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { ALL_MONITORED_QUEUES, WORKER_QUEUES } from '@open-brain/shared'
import { PipelineHealthSkill, LEGACY_MONITORED_QUEUES } from '../skills/pipeline-health.js'
import { alertStateKey, type AlertState } from '../lib/alert-state.js'
import type { QueueHandle, QueueFactory } from '../skills/pipeline-health.js'
import { PushoverService } from '../services/pushover.js'
import { pushMetrics } from '../lib/push-metrics.js'
import type { MetricLine } from '../lib/push-metrics.js'

// Mock pushMetrics to prevent real HTTP calls to Pushgateway during tests
vi.mock('../lib/push-metrics.js', () => ({
  pushMetrics: vi.fn().mockResolvedValue(undefined),
  buildExposition: vi.fn().mockReturnValue(''),
}))

// Mock node:fs/promises `stat` for the backup dead-man's-switch check
// (packages/workers/src/skills/pipeline-health.ts `checkBackupAge`).
// Default: always reject (ENOENT) — mirrors "mount not deployed yet" (7.4/OA-9),
// which is the safe default for the ~30 pre-existing tests below that don't
// configure this mock at all. Individual tests override with
// mockResolvedValueOnce/mockRejectedValueOnce.
const mockStat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'))
vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
}))

// ============================================================
// Mock queue factory helpers
// ============================================================

/**
 * Creates a mock QueueHandle with configurable job counts and stalled count.
 * All methods return the configured values; close() resolves immediately.
 */
function makeMockQueueHandle(counts: {
  waiting?: number
  active?: number
  failed?: number
  delayed?: number
  paused?: number
  stalled?: number
  /** Retained failed jobs; `countFailedSince` counts those finished at or after the cutoff (ZCOUNT on the failed set). */
  failedJobs?: Array<{ finishedOn?: number }>
} = {}): QueueHandle {
  const failedJobs = counts.failedJobs ?? []
  return {
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
    }),
    getJobCountByTypes: vi.fn().mockResolvedValue(counts.stalled ?? 0),
    countFailedSince: vi.fn().mockImplementation(async (sinceMs: number) =>
      failedJobs.filter(j => j.finishedOn !== undefined && j.finishedOn >= sinceMs).length),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Creates a mock QueueHandle that throws on getJobCounts and getJobCountByTypes.
 * Used for testing connection failure resilience.
 */
function makeBrokenQueueHandle(): QueueHandle {
  return {
    getJobCounts: vi.fn().mockRejectedValue(new Error('Redis ECONNREFUSED')),
    getJobCountByTypes: vi.fn().mockRejectedValue(new Error('Redis ECONNREFUSED')),
    countFailedSince: vi.fn().mockRejectedValue(new Error('Redis ECONNREFUSED')),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Creates a QueueFactory that returns per-queue configured mocks.
 *
 * @param overrides  Map of queue name → specific counts to configure for that queue.
 *                   Queues not in overrides get default (all-zero) counts.
 */
function makeMockQueueFactory(overrides: Record<string, {
  waiting?: number
  active?: number
  failed?: number
  delayed?: number
  paused?: number
  stalled?: number
  failedJobs?: Array<{ finishedOn?: number }>
  broken?: boolean
}> = {}): QueueFactory {
  return (name: string) => {
    const config = overrides[name]
    if (config?.broken) return makeBrokenQueueHandle()
    return makeMockQueueHandle(config ?? {})
  }
}

// ============================================================
// Fixtures
// ============================================================

const SAMPLE_FAILURES = [
  {
    capture_id: 'cap-1',
    stage: 'embed',
    error: 'LiteLLM timeout after 30s',
    created_at: new Date(Date.now() - 10 * 60 * 1000),
  },
  {
    capture_id: 'cap-2',
    stage: 'embed',
    error: 'Connection refused to llm.k4jda.net',
    created_at: new Date(Date.now() - 20 * 60 * 1000),
  },
  {
    capture_id: 'cap-3',
    stage: 'classify',
    error: 'Model not found',
    created_at: new Date(Date.now() - 5 * 60 * 1000),
  },
]

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(failures = SAMPLE_FAILURES) {
  // db.execute is called twice:
  //   1. pipeline_events failure query → returns failures rows
  //   2. capture flow COUNT query → returns count > 0 (healthy by default)
  const executeMock = vi.fn()
    .mockResolvedValueOnce({ rows: failures })
    .mockResolvedValueOnce({ rows: [{ count: '10' }] })
  return {
    execute: executeMock,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
    }),
  }
}

function makePushoverService(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

/**
 * Builds a PipelineHealthSkill with all external I/O mocked.
 */
function makeSkill(opts: {
  failures?: typeof SAMPLE_FAILURES
  pushoverConfigured?: boolean
  queueOverrides?: Record<string, {
    waiting?: number
    active?: number
    failed?: number
    delayed?: number
    paused?: number
    stalled?: number
    broken?: boolean
  }>
} = {}) {
  const db = makeMockDb(opts.failures ?? SAMPLE_FAILURES)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)
  const queueFactory = makeMockQueueFactory(opts.queueOverrides ?? {})

  const skill = new PipelineHealthSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    queueFactory,
    pushover,
  })

  return { skill, db, pushover, queueFactory }
}

// ============================================================
// Tests
// ============================================================

describe('PipelineHealthSkill', () => {
  // This suite pins the legacy direct-push behavior (as at f341ca6): it runs
  // with the alert-state path off, so every assertion below proves that
  // ALERT_STATE_ENABLED=false pushes exactly as before. The ADR-0005 path and
  // the switch matrix are covered in the "alert state" suite at the end.
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubEnv('ALERT_STATE_ENABLED', 'false')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // ----------------------------------------------------------
  // Happy path — healthy system
  // ----------------------------------------------------------

  describe('execute — healthy system', () => {
    it('returns healthy:true when no thresholds exceeded and no failures', async () => {
      const { skill } = makeSkill({ failures: [] })
      const result = await skill.execute()

      expect(result.healthy).toBe(true)
      expect(result.alertSent).toBe(false)
    })

    it('returns queue stats for every monitored queue (registry)', async () => {
      const { skill } = makeSkill({ failures: [] })
      const result = await skill.execute()

      expect(result.queues.length).toBe(ALL_MONITORED_QUEUES.length)
      const names = result.queues.map(q => q.name)
      expect(names).toContain('capture-pipeline')
      expect(names).toContain('embed-capture')
      expect(names).toContain('skill-execution')
      expect(names).toContain('daily-sweep')
    })

    it('returns durationMs >= 0', async () => {
      const { skill } = makeSkill({ failures: [] })
      const result = await skill.execute()

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('writes a skills_log entry on success', async () => {
      const { skill, db } = makeSkill({ failures: [] })
      await skill.execute()

      expect(db.insert).toHaveBeenCalled()
      const valuesSpy = (db.insert as ReturnType<typeof vi.fn>).mock.results[0].value.values
      const logEntry = valuesSpy.mock.calls[0][0]
      expect(logEntry.skill_name).toBe('pipeline-health')
      expect(logEntry.output_summary).toContain('healthy:true')
    })
  })

  // ----------------------------------------------------------
  // Threshold: failed jobs
  // ----------------------------------------------------------

  describe('execute — failed job threshold exceeded', () => {
    it('returns healthy:false when failed count >= threshold', async () => {
      const { skill } = makeSkill({
        failures: [],
        queueOverrides: { 'capture-pipeline': { failed: 10 } },
      })
      const result = await skill.execute({ failedThreshold: 5 })

      expect(result.healthy).toBe(false)
    })

    it('sends Pushover alert when failed threshold exceeded', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        queueOverrides: { 'embed-capture': { failed: 8 } },
      })
      const result = await skill.execute({ failedThreshold: 5 })

      expect(result.alertSent).toBe(true)
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open Brain: Pipeline Health Alert',
          priority: 1,
        }),
      )
    })

    it('includes failed queue name and count in alert message', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        queueOverrides: { 'embed-capture': { failed: 12 } },
      })
      await skill.execute({ failedThreshold: 5 })

      const sendCall = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sendCall.message).toContain('embed-capture')
      expect(sendCall.message).toContain('12')
    })

    it('does NOT alert when failed count is below threshold', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        queueOverrides: { 'embed-capture': { failed: 3 } },
      })
      const result = await skill.execute({ failedThreshold: 5 })

      expect(result.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // Threshold: waiting (backlog)
  // ----------------------------------------------------------

  describe('execute — waiting threshold exceeded', () => {
    it('returns healthy:false when waiting count >= threshold', async () => {
      const { skill } = makeSkill({
        failures: [],
        queueOverrides: { 'capture-pipeline': { waiting: 150 } },
      })
      const result = await skill.execute({ waitingThreshold: 100 })

      expect(result.healthy).toBe(false)
      expect(result.alertSent).toBe(true)
    })

    it('includes backlogged queue name and count in alert message', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        queueOverrides: { 'capture-pipeline': { waiting: 200 } },
      })
      await skill.execute({ waitingThreshold: 100 })

      const sendCall = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sendCall.message).toContain('capture-pipeline')
      expect(sendCall.message).toContain('200')
    })
  })

  // ----------------------------------------------------------
  // Stalled jobs
  // ----------------------------------------------------------

  describe('execute — stalled jobs', () => {
    it('returns healthy:false when stalled jobs detected', async () => {
      const { skill } = makeSkill({
        failures: [],
        queueOverrides: { 'embed-capture': { stalled: 2 } },
      })
      const result = await skill.execute({ alertOnStalled: true })

      expect(result.healthy).toBe(false)
      expect(result.alertSent).toBe(true)
    })

    it('includes stalled queue name in alert message', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        queueOverrides: { 'embed-capture': { stalled: 3 } },
      })
      await skill.execute({ alertOnStalled: true })

      const sendCall = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sendCall.message).toContain('embed-capture')
    })

    it('does NOT alert on stalled when alertOnStalled:false', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        queueOverrides: { 'embed-capture': { stalled: 5 } },
      })
      const result = await skill.execute({ alertOnStalled: false })

      expect(result.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // Recent failures from pipeline_events
  // ----------------------------------------------------------

  describe('execute — recent pipeline_events failures', () => {
    it('populates recentFailures from pipeline_events query', async () => {
      const { skill } = makeSkill({ failures: SAMPLE_FAILURES })
      // Use high thresholds so queue stats don't trigger alert
      const result = await skill.execute({ failedThreshold: 100, waitingThreshold: 10000 })

      expect(result.recentFailures.length).toBe(SAMPLE_FAILURES.length)
    })

    it('includes failure stage summary in alert message when alert triggered by queue threshold', async () => {
      const { skill, pushover } = makeSkill({
        failures: SAMPLE_FAILURES,
        queueOverrides: { 'embed-capture': { failed: 10 } },
      })
      await skill.execute({ failedThreshold: 5 })

      const sendCall = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sendCall.message).toContain('Recent failures')
    })

    it('returns empty recentFailures when DB query fails', async () => {
      const { skill, db } = makeSkill({ failures: [] })
      ;(db.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection lost'))

      const result = await skill.execute()

      expect(result.recentFailures).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // Pushover not configured
  // ----------------------------------------------------------

  describe('execute — Pushover not configured', () => {
    it('returns alertSent:false even if thresholds exceeded', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        pushoverConfigured: false,
        queueOverrides: { 'embed-capture': { failed: 20 } },
      })
      const result = await skill.execute({ failedThreshold: 5 })

      expect(result.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // Non-fatal: queue connection failure
  // ----------------------------------------------------------

  describe('execute — queue connection failure', () => {
    it('returns zeroed stats for a queue that fails to connect', async () => {
      const { skill } = makeSkill({
        failures: [],
        queueOverrides: { 'capture-pipeline': { broken: true } },
      })
      const result = await skill.execute()

      const cpStats = result.queues.find(q => q.name === 'capture-pipeline')
      expect(cpStats?.failed).toBe(0)
      expect(cpStats?.waiting).toBe(0)
    })

    it('continues to check other queues when one fails', async () => {
      const { skill } = makeSkill({
        failures: [],
        queueOverrides: { 'capture-pipeline': { broken: true } },
      })
      const result = await skill.execute()

      // Other queues should still be present
      expect(result.queues.length).toBe(ALL_MONITORED_QUEUES.length)
      const embedStats = result.queues.find(q => q.name === 'embed-capture')
      expect(embedStats).toBeDefined()
    })
  })

  // ----------------------------------------------------------
  // skills_log: failure writing is non-fatal
  // ----------------------------------------------------------

  describe('execute — skills_log failure is non-fatal', () => {
    it('completes successfully even if skills_log insert fails', async () => {
      const { skill, db } = makeSkill({ failures: [] })
      ;(db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('DB write failed')) }),
      })

      const result = await skill.execute()

      expect(result.healthy).toBe(true)
    })
  })

  // ----------------------------------------------------------
  // executePipelineHealth convenience function
  // ----------------------------------------------------------

  describe('executePipelineHealth', () => {
    it('is exported and callable as a module-level function', async () => {
      const { executePipelineHealth } = await import('../skills/pipeline-health.js')
      expect(typeof executePipelineHealth).toBe('function')
    })
  })

  // ----------------------------------------------------------
  // stalledByQueue in result
  // ----------------------------------------------------------

  describe('stalledByQueue in result', () => {
    it('returns stalledByQueue array covering every worker queue', async () => {
      const { skill } = makeSkill({ failures: [] })
      const result = await skill.execute()

      expect(Array.isArray(result.stalledByQueue)).toBe(true)
      expect(result.stalledByQueue.length).toBe(WORKER_QUEUES.length)
      const queueNames = result.stalledByQueue.map(s => s.queueName)
      expect(queueNames).toContain('capture-pipeline')
      expect(queueNames).toContain('skill-execution')
    })

    it('reports non-zero stalled count for affected queue', async () => {
      const { skill } = makeSkill({
        failures: [],
        queueOverrides: { 'embed-capture': { stalled: 3 } },
      })
      const result = await skill.execute({ alertOnStalled: false }) // disable alert for isolated test

      const stalledEntry = result.stalledByQueue.find(s => s.queueName === 'embed-capture')
      expect(stalledEntry?.stalledCount).toBe(3)
    })
  })

  // ----------------------------------------------------------
  // Multiple thresholds exceeded simultaneously
  // ----------------------------------------------------------

  describe('execute — multiple threshold violations', () => {
    it('includes all violation types in single alert message', async () => {
      const { skill, pushover } = makeSkill({
        failures: SAMPLE_FAILURES,
        queueOverrides: {
          'capture-pipeline': { failed: 10, waiting: 200 },
          'embed-capture': { stalled: 2 },
        },
      })
      await skill.execute({ failedThreshold: 5, waitingThreshold: 100, alertOnStalled: true })

      const sendCall = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      // Alert should mention failed queues, backlogged queues, stalled, and recent failures
      expect(sendCall.message).toContain('capture-pipeline')
    })
  })

  // ----------------------------------------------------------
  // Legacy message text is byte-identical to f341ca6
  // ----------------------------------------------------------

  describe('execute — legacy message text (as at f341ca6)', () => {
    it('queue alert text is unchanged', async () => {
      const { skill, pushover } = makeSkill({
        failures: SAMPLE_FAILURES,
        queueOverrides: {
          'capture-pipeline': { failed: 10, waiting: 200 },
          'embed-capture': { stalled: 2 },
        },
      })
      await skill.execute({ failedThreshold: 5, waitingThreshold: 100, alertOnStalled: true })

      expect(pushover.send).toHaveBeenCalledOnce()
      expect((pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
        title: 'Open Brain: Pipeline Health Alert',
        message: [
          'Pipeline Health Alert',
          'Failed jobs (>5): capture-pipeline=10',
          'Backlogged (>100): capture-pipeline=200',
          'Stalled jobs: embed-capture=2',
          'Recent failures: 3 (embed:2, classify:1)',
        ].join('\n'),
        priority: 1,
      })
    })

    it('F2: the legacy queue list is pinned to the f341ca6 set', () => {
      // `git show f341ca6:packages/workers/src/skills/pipeline-health.ts` ALL_QUEUE_NAMES
      expect([...LEGACY_MONITORED_QUEUES]).toEqual([
        'capture-pipeline',
        'embed-capture',
        'check-triggers',
        'extract-entities',
        'skill-execution',
        'notification',
        'access-stats',
        'daily-sweep',
      ])
    })

    it('F2: queues outside the f341ca6 list never trigger a legacy push', async () => {
      const { skill, pushover } = makeSkill({
        failures: [],
        queueOverrides: {
          'ingest-root': { failed: 50 },
          'wiki-ingest': { waiting: 500 },
          'extract-commitments': { stalled: 3 },
        },
      })
      const result = await skill.execute({ failedThreshold: 5, waitingThreshold: 100 })

      expect(pushover.send).not.toHaveBeenCalled()
      expect(result.healthy).toBe(true)
    })

    it('F2: the legacy path still reads `notification` failed jobs, as at f341ca6', async () => {
      const { skill, pushover } = makeSkill({ failures: [], queueOverrides: { notification: { failed: 7 } } })
      await skill.execute({ failedThreshold: 5 })

      expect(pushover.send).toHaveBeenCalledOnce()
      expect((pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0].message).toContain('Failed jobs (>5): notification=7')
    })

    it('backup-stale text is unchanged', async () => {
      mockStat.mockResolvedValueOnce({ mtime: new Date(Date.now() - 30 * 60 * 60 * 1000) } as never)
      const { skill, pushover } = makeSkill({ failures: [] })
      await skill.execute()

      expect(pushover.send).toHaveBeenCalledOnce()
      expect((pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
        title: 'Open Brain: Backup Stale',
        message:
          'Backup manifest is 30.0h old (threshold: 26.0h).\n' +
          'Check the offsite-backup/restore-rehearsal cron logs and .env.secrets ' +
          'readability in cron context. See docs/runbooks/backup-alert.md.',
        priority: 1,
      })
    })
  })

  // ----------------------------------------------------------
  // Backup dead-man's switch (7.4 / PE-H4 / RC-12 / SA-13 / A131)
  // ----------------------------------------------------------

  describe('execute — backup dead-man\'s switch', () => {
    beforeEach(() => {
      // pushMetrics' vi.fn() (from the module factory mock) is NOT reset by the
      // outer beforeEach's vi.restoreAllMocks() (that only restores vi.spyOn
      // spies) — clear its call history here so each test's assertions only
      // see calls made during that test's own skill.execute().
      ;(pushMetrics as unknown as Mock).mockClear()
    })

    /** Finds the pushMetrics() call that pushed the backup-age gauge, if any. */
    function findBackupMetricCall(): MetricLine[] | undefined {
      const calls = (pushMetrics as unknown as Mock).mock.calls as [MetricLine[]][]
      const match = calls.find(([metrics]) => metrics.some(m => m.name === 'openbrain_backup_age_seconds'))
      return match?.[0]
    }

    it('fresh manifest: pushes the gauge with a low age and does NOT send Pushover', async () => {
      mockStat.mockResolvedValueOnce({ mtime: new Date(Date.now() - 5_000) } as never) // 5s old

      const { skill, pushover } = makeSkill({ failures: [] })
      const result = await skill.execute()

      const backupMetrics = findBackupMetricCall()
      expect(backupMetrics).toBeDefined()
      const gauge = backupMetrics?.find(m => m.name === 'openbrain_backup_age_seconds')
      expect(gauge?.value).toBeGreaterThanOrEqual(0)
      expect(gauge?.value).toBeLessThan(60)

      expect(result.backupStale).toBe(false)
      expect(result.backupAgeSeconds).toBeGreaterThanOrEqual(0)
      expect(result.backupAgeSeconds).toBeLessThan(60)
      expect(result.healthy).toBe(true)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('stale manifest (>26h old): pushes the gauge AND sends a Pushover alert', async () => {
      const THIRTY_HOURS_MS = 30 * 60 * 60 * 1000
      mockStat.mockResolvedValueOnce({ mtime: new Date(Date.now() - THIRTY_HOURS_MS) } as never)

      const { skill, pushover } = makeSkill({ failures: [] })
      const result = await skill.execute()

      const backupMetrics = findBackupMetricCall()
      const gauge = backupMetrics?.find(m => m.name === 'openbrain_backup_age_seconds')
      expect(gauge?.value).toBeGreaterThan(93600)

      expect(result.backupStale).toBe(true)
      expect(result.healthy).toBe(false)
      expect(result.alertSent).toBe(true)

      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open Brain: Backup Stale',
          priority: 1,
        }),
      )
      const sendCall = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sendCall.message).toContain('backup-alert.md')
    })

    it('absent manifest: completes without throwing, no gauge pushed, no Pushover', async () => {
      mockStat.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'))

      const { skill, pushover } = makeSkill({ failures: [] })
      const result = await skill.execute()

      expect(result.backupStale).toBe(false)
      expect(result.backupAgeSeconds).toBeNull()
      expect(result.healthy).toBe(true)
      expect(pushover.send).not.toHaveBeenCalled()

      const backupMetrics = findBackupMetricCall()
      expect(backupMetrics).toBeUndefined()
    })

    it('respects BACKUP_MAX_AGE_SECONDS override', async () => {
      const previous = process.env.BACKUP_MAX_AGE_SECONDS
      process.env.BACKUP_MAX_AGE_SECONDS = '60' // 1 minute — trivially exceeded

      try {
        mockStat.mockResolvedValueOnce({ mtime: new Date(Date.now() - 5 * 60 * 1000) } as never) // 5 min old

        const { skill, pushover } = makeSkill({ failures: [] })
        const result = await skill.execute()

        expect(result.backupStale).toBe(true)
        expect(pushover.send).toHaveBeenCalled()
      } finally {
        if (previous === undefined) delete process.env.BACKUP_MAX_AGE_SECONDS
        else process.env.BACKUP_MAX_AGE_SECONDS = previous
      }
    })

    it('does not send a backup-stale Pushover when Pushover is not configured', async () => {
      const THIRTY_HOURS_MS = 30 * 60 * 60 * 1000
      mockStat.mockResolvedValueOnce({ mtime: new Date(Date.now() - THIRTY_HOURS_MS) } as never)

      const { skill, pushover } = makeSkill({ failures: [], pushoverConfigured: false })
      const result = await skill.execute()

      expect(result.backupStale).toBe(true)
      expect(result.alertSent).toBe(false)
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })
})

// ============================================================
// ADR-0005 alert state (item 2.2): switch matrix, fire-on-change, fail-open
// ============================================================

const THIRTY_HOURS_MS = 30 * 60 * 60 * 1000

/**
 * db mock that renders the real drizzle SQL and routes on it: an in-memory
 * `app_settings` alert-state store plus the pipeline-health read queries.
 */
function makeStatefulDb(opts: {
  captureCount?: string
  initial?: Record<string, AlertState>
  failStateReads?: boolean
  embed?: { stalled: number; unembedded: number; newest?: string | null; oldest?: string | null } | 'throw'
  stuck?: number
  share?: { complete: number; total: number }
} = {}) {
  const store = new Map<string, unknown>(
    Object.entries(opts.initial ?? {}).map(([k, v]) => [alertStateKey(k), v]),
  )
  const dialect = new PgDialect()
  const queries: string[] = []
  const execute = vi.fn().mockImplementation(async (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    queries.push(text)
    if (text.includes('INSERT INTO app_settings')) {
      store.set(params[0] as string, JSON.parse(params[1] as string))
      return { rows: [] }
    }
    if (text.includes('FROM app_settings')) {
      if (opts.failStateReads) throw new Error('db down')
      const v = store.get(params[0] as string)
      return { rows: v === undefined ? [] : [{ value: v }] }
    }
    if (text.includes('FROM pipeline_events')) return { rows: [] }
    if (text.includes('AS stalled')) {
      if (opts.embed === 'throw') throw new Error('db down')
      const e = opts.embed ?? { stalled: 0, unembedded: 0 }
      return { rows: [{ stalled: String(e.stalled), unembedded: String(e.unembedded), oldest_stalled_at: e.oldest ?? null, newest_embedded_at: e.newest ?? null }] }
    }
    if (text.includes('AS stuck')) return { rows: [{ stuck: String(opts.stuck ?? 0) }] }
    if (text.includes('AS complete_count')) {
      const sh = opts.share ?? { complete: 0, total: 0 }
      return { rows: [{ complete_count: String(sh.complete), total_count: String(sh.total) }] }
    }
    if (text.includes('FROM captures')) return { rows: [{ count: opts.captureCount ?? '10' }] }
    if (text.includes('FROM skills_log')) return { rows: [{ count: '0' }] }
    throw new Error(`unexpected SQL in test: ${text}`)
  })
  const db = {
    execute,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
    }),
  }
  return { db, store, queries }
}

type SendArgs = { title: string; message: string; priority?: number }

function sentCalls(pushover: PushoverService): SendArgs[] {
  return (pushover.send as unknown as Mock).mock.calls.map(c => c[0] as SendArgs)
}

describe('PipelineHealthSkill — alert state (ADR-0005)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Fake only Date: local noon keeps the capture-flow check inside active hours.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 23, 12, 0, 0))
    mockStat.mockReset()
    mockStat.mockRejectedValue(new Error('ENOENT: no such file or directory'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    mockStat.mockReset()
    mockStat.mockRejectedValue(new Error('ENOENT: no such file or directory'))
  })

  function staleBackup() {
    mockStat.mockResolvedValue({ mtime: new Date(Date.now() - THIRTY_HOURS_MS) } as never)
  }
  function freshBackup() {
    mockStat.mockResolvedValue({ mtime: new Date(Date.now() - 2 * 3600_000) } as never)
  }

  function makeSkillWith(db: unknown, pushover: PushoverService, queueOverrides: Parameters<typeof makeMockQueueFactory>[0] = {}) {
    return new PipelineHealthSkill({
      db: db as import('@open-brain/shared').Database,
      queueFactory: makeMockQueueFactory(queueOverrides),
      pushover,
    })
  }

  // ---------------- switch matrix ----------------

  it('both switches on (default): a stale backup sends the legacy push AND the stateful alert', async () => {
    staleBackup()
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()

    const result = await makeSkillWith(db, pushover).execute()

    expect(sentCalls(pushover).map(c => c.title)).toEqual(['Open Brain: Backup Stale', 'Backup Stale'])
    expect(result.alertSent).toBe(true)
    expect(store.get('alert_state:backup-stale')).toMatchObject({ status: 'bad' })
  })

  it('both switches on (default): failed queues send the legacy push AND the stateful alert', async () => {
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover, { 'embed-capture': { failed: 8, failedJobs: failedJobs(8, 3600_000) } })
      .execute({ failedThreshold: 5 })

    expect(sentCalls(pushover).map(c => c.title)).toEqual(['Open Brain: Pipeline Health Alert', 'Queue Failures: embed-capture'])
    expect(store.get('alert_state:queue-failed:embed-capture')).toMatchObject({ status: 'bad' })
  })

  it('ALERT_LEGACY_PUSH=false: stale backup on two runs sends once, then a priority -1 "resolved" on recovery', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()
    const skill = makeSkillWith(db, pushover)

    staleBackup()
    const first = await skill.execute()
    expect(sentCalls(pushover)).toHaveLength(1)
    expect(sentCalls(pushover)[0]).toMatchObject({ title: 'Backup Stale', priority: 1 })
    expect(sentCalls(pushover)[0].message).toContain('backup-alert.md')
    expect(first.alertSent).toBe(true)

    vi.setSystemTime(new Date(2026, 10, 23, 18, 0, 0))
    const second = await skill.execute()
    expect(sentCalls(pushover)).toHaveLength(1) // none on the second bad run
    expect(second.alertSent).toBe(false)
    expect(second.backupStale).toBe(true)

    vi.setSystemTime(new Date(2026, 10, 24, 12, 0, 0))
    freshBackup()
    await skill.execute()
    expect(sentCalls(pushover)).toHaveLength(2)
    expect(sentCalls(pushover)[1]).toMatchObject({ title: 'Resolved: Backup Stale', priority: -1 })
    expect(store.get('alert_state:backup-stale')).toMatchObject({ status: 'ok' })
  })

  it('ALERT_STATE_ENABLED=false: legacy pushes only, no alert-state read or write', async () => {
    vi.stubEnv('ALERT_STATE_ENABLED', 'false')
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false') // ignored while the state path is off
    staleBackup()
    const { db, store, queries } = makeStatefulDb({ captureCount: '0' })
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover, { 'embed-capture': { failed: 8 } }).execute({ failedThreshold: 5 })

    expect(sentCalls(pushover).map(c => c.title)).toEqual(['Open Brain: Pipeline Health Alert', 'Open Brain: Backup Stale'])
    expect(queries.some(q => q.includes('app_settings'))).toBe(false)
    expect(store.size).toBe(0)
  })

  // ---------------- independent keys ----------------

  it('a queue backlog while the backup is fresh writes queue-backlog:<queue> and leaves backup-stale unchanged', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    freshBackup()
    const backupOk: AlertState = {
      status: 'ok', since: '2026-11-01T00:00:00.000Z', last_notified_at: null, level: 0, receipt: null, acked_at: null,
    }
    const { db, store } = makeStatefulDb({ initial: { 'backup-stale': backupOk } })
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover, { 'capture-pipeline': { waiting: 500 } }).execute({ waitingThreshold: 100 })

    expect(store.get('alert_state:queue-backlog:capture-pipeline')).toMatchObject({ status: 'bad' })
    expect(store.get('alert_state:backup-stale')).toEqual(backupOk)
    expect(sentCalls(pushover)).toHaveLength(1)
    expect(sentCalls(pushover)[0]).toMatchObject({ title: 'Queue Backlog: capture-pipeline', priority: 0 })
    expect(sentCalls(pushover)[0].message).toContain('capture-pipeline: 500 waiting jobs')
  })

  it('backup, a stalled queue and capture flow are three separate alerts', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    staleBackup()
    const { db, store } = makeStatefulDb({ captureCount: '0' })
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover, { 'embed-capture': { stalled: 2 } }).execute()

    expect(sentCalls(pushover).map(c => c.title).sort()).toEqual(['Backup Stale', 'Capture Flow Stale', 'Queue Stalled: embed-capture'])
    expect([...store.keys()].sort()).toEqual([
      'alert_state:backup-stale',
      'alert_state:capture-flow',
      'alert_state:queue-stalled:embed-capture',
    ])
  })

  it('a queue returning to normal sends "Resolved: Queue Backlog: <queue>" at priority -1', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const open: AlertState = {
      status: 'bad', since: '2026-11-22T12:00:00.000Z', last_notified_at: '2026-11-22T12:00:00.000Z', level: 0, receipt: null, acked_at: null,
    }
    const { db, store } = makeStatefulDb({ initial: { 'queue-backlog:capture-pipeline': open } })
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover).execute()

    expect(sentCalls(pushover)).toEqual([
      expect.objectContaining({ title: 'Resolved: Queue Backlog: capture-pipeline', priority: -1 }),
    ])
    expect(store.get('alert_state:queue-backlog:capture-pipeline')).toMatchObject({ status: 'ok' })
  })

  // ---------------- per-queue keys + recent failures (review F1) ----------------

  /** `count` failed jobs that finished `ageMs` ago (newest-first order is preserved by equal times). */
  function failedJobs(count: number, ageMs: number) {
    return Array.from({ length: count }, () => ({ finishedOn: Date.now() - ageMs }))
  }
  const OPEN_SINCE_YESTERDAY: AlertState = {
    status: 'bad', since: '2026-11-22T12:00:00.000Z', last_notified_at: '2026-11-22T12:00:00.000Z', level: 0, receipt: null, acked_at: null,
  }

  it('F1: one alert key per queue: a new failure burst in a second queue fires while the first queue\'s alert is open', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, store } = makeStatefulDb({ initial: { 'queue-failed:ingest-root': OPEN_SINCE_YESTERDAY } })
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover, {
      'ingest-root': { failed: 9, failedJobs: failedJobs(9, 3600_000) },
      'embed-capture': { failed: 6, failedJobs: failedJobs(6, 3600_000) },
    }).execute({ failedThreshold: 5 })

    expect(sentCalls(pushover)).toEqual([expect.objectContaining({ title: 'Queue Failures: embed-capture', priority: 0 })])
    expect(sentCalls(pushover)[0].message).toContain('embed-capture: 6 failed jobs in the last 6 h')
    expect(store.get('alert_state:queue-failed:embed-capture')).toMatchObject({ status: 'bad' })
    expect(store.get('alert_state:queue-failed:ingest-root')).toEqual(OPEN_SINCE_YESTERDAY) // held, not re-sent
  })

  it('F1: counts failed jobs that finished in the last 6 h, not the retained failed total', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover, {
      // retained flow-queue failures from two days ago: not a current failure signal
      'ingest-root': { failed: 500, failedJobs: failedJobs(500, 48 * 3600_000) },
      // 3 recent + 5 from 7 h ago: below the threshold of 5 inside the window
      'extract-commitments': { failed: 8, failedJobs: [...failedJobs(3, 3600_000), ...failedJobs(5, 7 * 3600_000)] },
    }).execute({ failedThreshold: 5 })

    expect(sentCalls(pushover)).toEqual([])
    expect([...store.keys()]).toEqual([])
  })

  it('F1: failures are counted with one O(log n) count per window (6 h alert, 24 h gauge), no job scan', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()
    const calls: Record<string, number[]> = {}
    const jobsByQueue: Record<string, Array<{ finishedOn: number }>> = {
      'ingest-root': failedJobs(5000, 60_000),
      'wiki-ingest': failedJobs(300, 48 * 3600_000),
    }
    const factory: QueueFactory = (name) => {
      const handle = makeMockQueueFactory()(name)
      handle.countFailedSince = vi.fn().mockImplementation(async (since: number) => {
        ;(calls[name] ??= []).push(since)
        return (jobsByQueue[name] ?? []).filter(j => j.finishedOn >= since).length
      })
      return handle
    }

    await new PipelineHealthSkill({ db: db as never, queueFactory: factory, pushover }).execute({ failedThreshold: 5 })

    expect(calls['ingest-root']).toHaveLength(2)
    expect(Math.round((Date.now() - calls['ingest-root'][0]) / 3600_000)).toBe(6)
    expect(Math.round((Date.now() - calls['ingest-root'][1]) / 3600_000)).toBe(24)
    expect(store.get('alert_state:queue-failed:ingest-root')).toMatchObject({ status: 'bad' })
    expect(store.has('alert_state:queue-failed:wiki-ingest')).toBe(false)
  })

  it('F1: a failed-job scan error holds that queue\'s open failure alert (no false "resolved")', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, store } = makeStatefulDb({ initial: { 'queue-failed:ingest-root': OPEN_SINCE_YESTERDAY } })
    const pushover = makePushoverService()
    const factory: QueueFactory = (name) => {
      const handle = makeMockQueueFactory()(name)
      if (name === 'ingest-root') handle.countFailedSince = vi.fn().mockRejectedValue(new Error('Redis timeout'))
      return handle
    }

    await new PipelineHealthSkill({ db: db as never, queueFactory: factory, pushover }).execute()

    expect(sentCalls(pushover)).toEqual([])
    expect(store.get('alert_state:queue-failed:ingest-root')).toEqual(OPEN_SINCE_YESTERDAY)
  })

  // ---------------- capture flow ----------------

  it('capture flow stale (active hours) sends one warning; legacy 24h suppression query is not run', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, queries } = makeStatefulDb({ captureCount: '0' })
    const pushover = makePushoverService()

    const result = await makeSkillWith(db, pushover).execute()

    expect(sentCalls(pushover)).toEqual([
      expect.objectContaining({ title: 'Capture Flow Stale', priority: 0 }),
    ])
    expect(result.captureFlowStale).toBe(true)
    expect(queries.some(q => q.includes('FROM skills_log'))).toBe(false)
  })

  it('quiet hours: the capture-flow condition is not observed, so an open alert is held (no false "resolved")', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    vi.setSystemTime(new Date(2026, 10, 23, 3, 0, 0))
    const open: AlertState = {
      status: 'bad', since: '2026-11-22T18:00:00.000Z', last_notified_at: '2026-11-22T18:00:00.000Z', level: 0, receipt: null, acked_at: null,
    }
    const { db, store, queries } = makeStatefulDb({ initial: { 'capture-flow': open } })
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover).execute()

    expect(sentCalls(pushover)).toEqual([])
    expect(store.get('alert_state:capture-flow')).toEqual(open)
    expect(queries.some(q => q.includes('FROM captures') && q.includes('as count'))).toBe(false) // capture-flow COUNT query not run
  })

  it('absent backup manifest: the backup condition is not observed, so an open alert is held', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const open: AlertState = {
      status: 'bad', since: '2026-11-22T12:00:00.000Z', last_notified_at: '2026-11-22T12:00:00.000Z', level: 0, receipt: null, acked_at: null,
    }
    const { db, store } = makeStatefulDb({ initial: { 'backup-stale': open } })
    const pushover = makePushoverService()

    await makeSkillWith(db, pushover).execute() // mockStat rejects: manifest absent

    expect(sentCalls(pushover)).toEqual([])
    expect(store.get('alert_state:backup-stale')).toEqual(open)
  })

  // ---------------- fail open ----------------

  it('fail open: an alert-state read error still sends the backup-stale alert', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    staleBackup()
    const { db } = makeStatefulDb({ failStateReads: true })
    const pushover = makePushoverService()

    const result = await makeSkillWith(db, pushover).execute()

    expect(sentCalls(pushover)).toEqual([expect.objectContaining({ title: 'Backup Stale', priority: 1 })])
    expect(result.alertSent).toBe(true)
  })
})

// ============================================================
// Item 3.1: failures that can clear, embed-stall, stuck captures, gauges
// ============================================================

describe('PipelineHealthSkill — item 3.1 (24 h failures, embed-stall, gauges)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 23, 12, 0, 0))
    mockStat.mockReset()
    mockStat.mockRejectedValue(new Error('ENOENT: no such file or directory'))
    ;(pushMetrics as unknown as Mock).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  const jobs = (count: number, ageMs: number) => Array.from({ length: count }, () => ({ finishedOn: Date.now() - ageMs }))

  function skillFor(db: unknown, pushover: PushoverService, overrides: Parameters<typeof makeMockQueueFactory>[0] = {}) {
    return new PipelineHealthSkill({
      db: db as import('@open-brain/shared').Database,
      queueFactory: makeMockQueueFactory(overrides),
      pushover,
    })
  }

  function pushedMetrics(): MetricLine[] {
    return ((pushMetrics as unknown as Mock).mock.calls as [MetricLine[]][]).flatMap(c => c[0])
  }

  it('354 retained failures that all finished more than 24 h ago: healthy, no alert, 24 h gauge is 0', async () => {
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()

    const result = await skillFor(db, pushover, {
      'ingest-root': { failed: 354, failedJobs: jobs(354, 48 * 3600_000) },
    }).execute({ failedThreshold: 5 })

    expect(result.healthy).toBe(true)
    expect(sentCalls(pushover)).toEqual([])
    expect([...store.keys()]).toEqual([])
    const g = pushedMetrics().find(m => m.name === 'openbrain_queue_failed_24h' && m.labels?.queue === 'ingest-root')
    expect(g?.value).toBe(0)
    // the retained total keeps its own gauge
    expect(pushedMetrics().find(m => m.name === 'openbrain_queue_failed' && m.labels?.queue === 'ingest-root')?.value).toBe(354)
  })

  it('5 failures in the window raise the queue key once, then "resolved" on the next clear run', async () => {
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()

    const failedAt11 = jobs(5, 3600_000)
    await skillFor(db, pushover, { 'embed-capture': { failed: 5, failedJobs: failedAt11 } }).execute({ failedThreshold: 5 })
    expect(sentCalls(pushover)).toEqual([expect.objectContaining({ title: 'Queue Failures: embed-capture', priority: 0 })])

    // next run: the same 5 jobs are now older than the window
    vi.setSystemTime(new Date(2026, 10, 23, 20, 0, 0))
    await skillFor(db, pushover, { 'embed-capture': { failed: 5, failedJobs: failedAt11 } }).execute({ failedThreshold: 5 })
    expect(sentCalls(pushover)).toHaveLength(2)
    expect(sentCalls(pushover)[1]).toMatchObject({ title: 'Resolved: Queue Failures: embed-capture', priority: -1 })
    expect(store.get('alert_state:queue-failed:embed-capture')).toMatchObject({ status: 'ok' })
  })

  it('gauges: failed_24h per worker queue counts only the last 24 h', async () => {
    const { db } = makeStatefulDb()
    await skillFor(db, makePushoverService(), {
      'embed-capture': { failed: 9, failedJobs: [...jobs(2, 3600_000), ...jobs(3, 10 * 3600_000), ...jobs(4, 30 * 3600_000)] },
    }).execute()
    const g = pushedMetrics().find(m => m.name === 'openbrain_queue_failed_24h' && m.labels?.queue === 'embed-capture')
    expect(g?.value).toBe(5)
  })

  it('embed-stall: a capture unembedded for 3 h fires one critical alert, silent on the next run, resolved after', async () => {
    const { db, store } = makeStatefulDb({ embed: { stalled: 1, unembedded: 1, oldest: '2026-11-23T09:00:00.000Z', newest: '2026-11-23T08:00:00.000Z' } })
    const pushover = makePushoverService()
    const skill = skillFor(db, pushover)

    const r1 = await skill.execute()
    expect(sentCalls(pushover)).toEqual([expect.objectContaining({ title: 'Embeddings Stalled', priority: 1 })])
    expect(sentCalls(pushover)[0].message).toContain('1 ')
    expect(r1.embedStalled).toBe(1)
    expect(r1.healthy).toBe(false)

    vi.setSystemTime(new Date(2026, 10, 23, 18, 0, 0))
    await skill.execute()
    expect(sentCalls(pushover)).toHaveLength(1)

    vi.setSystemTime(new Date(2026, 10, 24, 0, 0, 0))
    const { db: db2 } = makeStatefulDb({ initial: { 'embed-stall': store.get('alert_state:embed-stall') as AlertState } })
    await skillFor(db2, pushover).execute()
    expect(sentCalls(pushover)[1]).toMatchObject({ title: 'Resolved: Embeddings Stalled', priority: -1 })
  })

  it('embed-stall: today\'s state (2 deliberately failed captures, nothing stalled) does not fire', async () => {
    const { db, store } = makeStatefulDb({ embed: { stalled: 0, unembedded: 2 } })
    const pushover = makePushoverService()

    const r = await skillFor(db, pushover).execute()

    expect(sentCalls(pushover)).toEqual([])
    expect(r.embedStalled).toBe(0)
    expect(store.has('alert_state:embed-stall')).toBe(false)
  })

  it('embed-stall: a failed query is not observed, so an open alert is held', async () => {
    const open: AlertState = { status: 'bad', since: '2026-11-22T12:00:00.000Z', last_notified_at: '2026-11-22T12:00:00.000Z', level: 1, receipt: null, acked_at: null }
    const { db, store } = makeStatefulDb({ embed: 'throw', initial: { 'embed-stall': open } })
    const pushover = makePushoverService()

    await skillFor(db, pushover).execute()

    expect(sentCalls(pushover)).toEqual([])
    expect(store.get('alert_state:embed-stall')).toEqual(open)
  })

  it('stuck captures, unembedded and success share are pushed as gauges and summarised', async () => {
    const { db } = makeStatefulDb({ embed: { stalled: 0, unembedded: 2 }, stuck: 4, share: { complete: 97, total: 100 } })
    const pushover = makePushoverService()

    const r = await skillFor(db, pushover).execute()

    const val = (n: string) => pushedMetrics().find(m => m.name === n)?.value
    expect(val('openbrain_captures_stuck')).toBe(4)
    expect(val('openbrain_captures_unembedded')).toBe(2)
    expect(val('openbrain_pipeline_success_share_7d')).toBeCloseTo(0.97)
    expect(r.stuckCaptures).toBe(4)
    expect(sentCalls(pushover)).toEqual([]) // stuck captures are a gauge, not a page
  })

  it('backup-stale fires through its own key and call, independent of the queue alert', async () => {
    mockStat.mockResolvedValue({ mtime: new Date(Date.now() - 30 * 3600_000) } as never)
    const { db, store } = makeStatefulDb()
    const pushover = makePushoverService()

    await skillFor(db, pushover, { 'embed-capture': { failed: 6, failedJobs: jobs(6, 3600_000) } }).execute({ failedThreshold: 5 })

    expect(sentCalls(pushover).map(c => c.title).sort()).toEqual(['Backup Stale', 'Queue Failures: embed-capture'])
    expect(store.get('alert_state:backup-stale')).toMatchObject({ status: 'bad' })
    expect(store.get('alert_state:queue-failed:embed-capture')).toMatchObject({ status: 'bad' })
  })
})

describe('pipeline-health-query — item 3.1 SQL', () => {
  const dialect = new PgDialect()
  function capture(rows: unknown[]) {
    const seen: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      execute: vi.fn().mockImplementation(async (q: SQL) => {
        const r = dialect.sqlToQuery(q)
        seen.push({ sql: r.sql, params: r.params })
        return { rows }
      }),
    }
    return { db: db as unknown as import('@open-brain/shared').Database, seen }
  }

  it('queryEmbedStall: live, unembedded, older than 2 h, not failed/deleted', async () => {
    const { queryEmbedStall } = await import('../skills/pipeline-health-query.js')
    const { db, seen } = capture([{ stalled: '3', unembedded: '5', oldest_stalled_at: null, newest_embedded_at: '2026-11-23T08:00:00Z' }])
    const r = await queryEmbedStall(db, 2)
    expect(r).toMatchObject({ stalled: 3, unembedded: 5 })
    expect(r?.newestEmbeddedAt).toBeInstanceOf(Date)
    expect(seen[0].sql).toContain('embedding IS NULL')
    expect(seen[0].sql).toContain('deleted_at IS NULL')
    expect(seen[0].sql).toContain("'failed'")
  })

  it('queryEmbedStall: returns null when the query fails or the row is malformed', async () => {
    const { queryEmbedStall } = await import('../skills/pipeline-health-query.js')
    const bad = { execute: vi.fn().mockRejectedValue(new Error('x')) } as unknown as import('@open-brain/shared').Database
    expect(await queryEmbedStall(bad, 2)).toBeNull()
    const { db } = capture([{ count: '1' }])
    expect(await queryEmbedStall(db, 2)).toBeNull()
  })

  it('queryStuckCaptures binds exactly SWEEPABLE_STATUSES and excludes deleted rows', async () => {
    const { queryStuckCaptures } = await import('../skills/pipeline-health-query.js')
    const { SWEEPABLE_STATUSES } = await import('../lib/sweepable-statuses.js')
    const { db, seen } = capture([{ stuck: '4' }])
    expect(await queryStuckCaptures(db)).toBe(4)
    expect(seen[0].sql).toContain('deleted_at IS NULL')
    for (const st of SWEEPABLE_STATUSES) expect(seen[0].params).toContain(st)
    expect(await queryStuckCaptures({ execute: vi.fn().mockRejectedValue(new Error('x')) } as never)).toBeNull()
  })

  it('queryPipelineSuccessShare: complete share over the window, null when empty or on error', async () => {
    const { queryPipelineSuccessShare } = await import('../skills/pipeline-health-query.js')
    expect(await queryPipelineSuccessShare(capture([{ complete_count: '95', total_count: '100' }]).db, 7)).toBeCloseTo(0.95)
    expect(await queryPipelineSuccessShare(capture([{ complete_count: '0', total_count: '0' }]).db, 7)).toBeNull()
    expect(await queryPipelineSuccessShare({ execute: vi.fn().mockRejectedValue(new Error('x')) } as never, 7)).toBeNull()
  })
})
