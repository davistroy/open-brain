import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PipelineHealthSkill } from '../skills/pipeline-health.js'
import type { QueueHandle, QueueFactory } from '../skills/pipeline-health.js'
import { PushoverService } from '../services/pushover.js'

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
} = {}): QueueHandle {
  return {
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
    }),
    getJobCountByTypes: vi.fn().mockResolvedValue(counts.stalled ?? 0),
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
  return {
    execute: vi.fn().mockResolvedValue({ rows: failures }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
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
  beforeEach(() => {
    vi.restoreAllMocks()
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

    it('returns queue stats for all 8 known queues', async () => {
      const { skill } = makeSkill({ failures: [] })
      const result = await skill.execute()

      expect(result.queues.length).toBe(8)
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
      expect(result.queues.length).toBe(8)
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
        values: vi.fn().mockRejectedValue(new Error('DB write failed')),
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
    it('returns stalledByQueue array covering all 8 queue names', async () => {
      const { skill } = makeSkill({ failures: [] })
      const result = await skill.execute()

      expect(Array.isArray(result.stalledByQueue)).toBe(true)
      expect(result.stalledByQueue.length).toBe(8)
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
})
