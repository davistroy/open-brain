import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StaleCapturesSkill } from '../skills/stale-captures.js'
import type { StaleCapturesOptions } from '../skills/stale-captures.js'
import { PushoverService } from '../services/pushover.js'

// ============================================================
// Fixtures
// ============================================================

const NOW = new Date('2026-03-06T12:00:00Z')

/** Captures stuck in various states */
const STALE_RECEIVED = {
  id: 'cap-aaaaaaaaa1',
  pipeline_status: 'received',
  created_at: '2026-03-06T10:00:00Z', // 120min ago
  age_minutes: 120,
}

const STALE_PROCESSING = {
  id: 'cap-bbbbbbbbb2',
  pipeline_status: 'processing',
  created_at: '2026-03-06T10:30:00Z', // 90min ago
  age_minutes: 90,
}

const STALE_RECENT = {
  id: 'cap-ccccccccc3',
  pipeline_status: 'received',
  created_at: '2026-03-06T11:30:00Z', // 30min ago — below 60min threshold
  age_minutes: 30,
}

// ============================================================
// Mock helpers
// ============================================================

/**
 * Creates a mock DB that returns the given stale rows from execute()
 * and records insert() calls for skills_log verification.
 */
function makeMockDb(staleRows: typeof STALE_RECEIVED[] = [STALE_RECEIVED, STALE_PROCESSING]) {
  const insertValues = vi.fn().mockResolvedValue(undefined)
  return {
    execute: vi.fn().mockResolvedValue({ rows: staleRows }),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    _insertValues: insertValues,
  }
}

/**
 * Creates a mock BullMQ queue with a spy on add().
 */
function makeMockQueue(shouldFailForId?: string) {
  return {
    add: vi.fn().mockImplementation(async (_name: string, data: { captureId: string }) => {
      if (shouldFailForId && data.captureId === shouldFailForId) {
        throw new Error('BullMQ connection error')
      }
      return { id: data.captureId }
    }),
  }
}

/**
 * Creates a PushoverService with send() mocked.
 */
function makePushoverService(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

/**
 * Builds a StaleCapturesSkill with all external I/O mocked.
 */
function makeSkill(opts: {
  staleRows?: typeof STALE_RECEIVED[]
  queueFailForId?: string
  pushoverConfigured?: boolean
} = {}) {
  const db = makeMockDb(opts.staleRows ?? [STALE_RECEIVED, STALE_PROCESSING])
  const queue = makeMockQueue(opts.queueFailForId)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const skill = new StaleCapturesSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    capturePipelineQueue: queue as any,
    pushover,
  })

  return { skill, db, queue, pushover }
}

// ============================================================
// Tests
// ============================================================

describe('StaleCapturesSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------
  // No stale captures
  // ----------------------------------------------------------

  describe('execute — no stale captures', () => {
    it('returns zero counts when no stale captures found', async () => {
      const { skill, queue, pushover } = makeSkill({ staleRows: [] })

      const result = await skill.execute()

      expect(result.found).toBe(0)
      expect(result.requeued).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.staleCaptures).toHaveLength(0)
    })

    it('does not call queue.add when no stale captures found', async () => {
      const { skill, queue } = makeSkill({ staleRows: [] })

      await skill.execute()

      expect(queue.add).not.toHaveBeenCalled()
    })

    it('does not send Pushover when no stale captures found', async () => {
      const { skill, pushover } = makeSkill({ staleRows: [] })

      await skill.execute()

      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('writes skills_log entry even when no captures found', async () => {
      const { skill, db } = makeSkill({ staleRows: [] })

      await skill.execute()

      expect(db.insert).toHaveBeenCalledOnce()
      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          skill_name: 'stale-captures',
          output_summary: 'No stale captures found',
        }),
      )
    })
  })

  // ----------------------------------------------------------
  // Happy path — stale captures found and re-queued
  // ----------------------------------------------------------

  describe('execute — stale captures found', () => {
    it('returns correct found/requeued counts', async () => {
      const { skill } = makeSkill()

      const result = await skill.execute()

      expect(result.found).toBe(2)
      expect(result.requeued).toBe(2)
      expect(result.failed).toBe(0)
    })

    it('returns stale capture details', async () => {
      const { skill } = makeSkill()

      const result = await skill.execute()

      expect(result.staleCaptures).toHaveLength(2)
      expect(result.staleCaptures[0].id).toBe(STALE_RECEIVED.id)
      expect(result.staleCaptures[0].pipeline_status).toBe('received')
      expect(result.staleCaptures[0].age_minutes).toBe(120)
      expect(result.staleCaptures[1].id).toBe(STALE_PROCESSING.id)
      expect(result.staleCaptures[1].pipeline_status).toBe('processing')
    })

    it('calls queue.add for each stale capture with captureId as jobId (idempotency)', async () => {
      const { skill, queue } = makeSkill()

      await skill.execute()

      expect(queue.add).toHaveBeenCalledTimes(2)
      expect(queue.add).toHaveBeenCalledWith(
        'ingest',
        { captureId: STALE_RECEIVED.id },
        { jobId: STALE_RECEIVED.id },
      )
      expect(queue.add).toHaveBeenCalledWith(
        'ingest',
        { captureId: STALE_PROCESSING.id },
        { jobId: STALE_PROCESSING.id },
      )
    })

    it('sends Pushover notification on successful re-queue', async () => {
      const { skill, pushover } = makeSkill()

      await skill.execute()

      expect(pushover.send).toHaveBeenCalledOnce()
      const sendCall = (pushover.send as unknown as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as any
      expect(sendCall.title).toBe('Open Brain: Stale Captures Re-queued')
      expect(sendCall.priority).toBe(1) // high priority
      expect(sendCall.message).toContain('2 stale captures')
    })

    it('includes re-queue count in Pushover message', async () => {
      const { skill, pushover } = makeSkill()

      await skill.execute()

      const message = ((pushover.send as unknown as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as any).message
      expect(message).toContain('Re-queued: 2')
    })

    it('includes oldest age in Pushover message', async () => {
      const { skill, pushover } = makeSkill()

      await skill.execute()

      const message = ((pushover.send as unknown as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as any).message
      expect(message).toContain('120min') // oldest is 120min
    })

    it('includes capture ID snippets in Pushover message', async () => {
      const { skill, pushover } = makeSkill()

      await skill.execute()

      const message = ((pushover.send as unknown as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as any).message
      // First 8 chars of STALE_RECEIVED.id = 'cap-aaaa'
      expect(message).toContain('cap-aaaa')
    })

    it('writes skills_log entry with correct summary', async () => {
      const { skill, db } = makeSkill()

      await skill.execute()

      expect(db.insert).toHaveBeenCalledOnce()
      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          skill_name: 'stale-captures',
          output_summary: expect.stringContaining('found:2'),
        }),
      )
    })

    it('includes threshold and oldest age in skills_log output summary', async () => {
      const { skill, db } = makeSkill()

      await skill.execute({ thresholdMinutes: 60 })

      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          output_summary: expect.stringContaining('threshold:60min'),
        }),
      )
      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          output_summary: expect.stringContaining('oldest:120min'),
        }),
      )
    })

    it('includes threshold in skills_log input summary', async () => {
      const { skill, db } = makeSkill()

      await skill.execute({ thresholdMinutes: 45 })

      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          input_summary: 'threshold: 45min',
        }),
      )
    })
  })

  // ----------------------------------------------------------
  // Configurable threshold
  // ----------------------------------------------------------

  describe('execute — threshold configuration', () => {
    it('calls db.execute once (once for the stale query)', async () => {
      const { skill, db } = makeSkill()

      await skill.execute()

      expect(db.execute).toHaveBeenCalledOnce()
    })

    it('with custom threshold: still queries and re-queues found captures', async () => {
      // Verify the threshold is wired through — mock returns same data regardless
      // of SQL parameters; the key test is that the skill uses the value correctly
      const { skill, queue } = makeSkill()

      const result = await skill.execute({ thresholdMinutes: 30 })

      // DB was called once (with the 30-minute threshold embedded in the raw SQL)
      expect(queue.add).toHaveBeenCalledTimes(2)
      expect(result.found).toBe(2)
    })

    it('uses custom threshold in skills_log input summary', async () => {
      const { skill, db } = makeSkill()

      await skill.execute({ thresholdMinutes: 120 })

      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          input_summary: 'threshold: 120min',
        }),
      )
    })
  })

  // ----------------------------------------------------------
  // Partial re-queue failure
  // ----------------------------------------------------------

  describe('execute — partial re-queue failure', () => {
    it('counts failed re-queues separately from successful ones', async () => {
      const { skill } = makeSkill({ queueFailForId: STALE_RECEIVED.id })

      const result = await skill.execute()

      expect(result.requeued).toBe(1) // STALE_PROCESSING succeeded
      expect(result.failed).toBe(1)  // STALE_RECEIVED failed
      expect(result.found).toBe(2)
    })

    it('still sends Pushover when some re-queues fail', async () => {
      const { skill, pushover } = makeSkill({ queueFailForId: STALE_RECEIVED.id })

      await skill.execute()

      expect(pushover.send).toHaveBeenCalledOnce()
    })

    it('includes failed count in Pushover message', async () => {
      const { skill, pushover } = makeSkill({ queueFailForId: STALE_RECEIVED.id })

      await skill.execute()

      const message = ((pushover.send as unknown as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as any).message
      expect(message).toContain('Failed to re-queue: 1')
    })

    it('still writes skills_log when some re-queues fail', async () => {
      const { skill, db } = makeSkill({ queueFailForId: STALE_RECEIVED.id })

      await skill.execute()

      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          output_summary: expect.stringContaining('requeued:1'),
        }),
      )
      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          output_summary: expect.stringContaining('failed:1'),
        }),
      )
    })
  })

  // ----------------------------------------------------------
  // Pushover not configured
  // ----------------------------------------------------------

  describe('execute — Pushover not configured', () => {
    it('skips Pushover when not configured but still re-queues captures', async () => {
      const { skill, queue, pushover } = makeSkill({ pushoverConfigured: false })

      const result = await skill.execute()

      expect(pushover.send).not.toHaveBeenCalled()
      expect(queue.add).toHaveBeenCalledTimes(2)
      expect(result.requeued).toBe(2)
    })

    it('still writes skills_log when Pushover not configured', async () => {
      const { skill, db } = makeSkill({ pushoverConfigured: false })

      await skill.execute()

      expect(db.insert).toHaveBeenCalledOnce()
    })
  })

  // ----------------------------------------------------------
  // Pushover delivery failure (non-fatal)
  // ----------------------------------------------------------

  describe('execute — Pushover delivery failure', () => {
    it('continues and returns result when Pushover throws', async () => {
      const { skill, pushover } = makeSkill()
      vi.spyOn(pushover, 'send').mockRejectedValue(new Error('Pushover API timeout'))

      const result = await skill.execute()

      // Should still return successful re-queue result
      expect(result.requeued).toBe(2)
      expect(result.failed).toBe(0)
    })

    it('still writes skills_log when Pushover throws', async () => {
      const { skill, db, pushover } = makeSkill()
      vi.spyOn(pushover, 'send').mockRejectedValue(new Error('Pushover API timeout'))

      await skill.execute()

      expect(db.insert).toHaveBeenCalledOnce()
    })
  })

  // ----------------------------------------------------------
  // skills_log failure (non-fatal)
  // ----------------------------------------------------------

  describe('execute — skills_log failure', () => {
    it('does not throw when skills_log insert fails', async () => {
      const { skill, db } = makeSkill()
      db._insertValues.mockRejectedValue(new Error('DB connection lost'))

      await expect(skill.execute()).resolves.toBeDefined()
    })

    it('still returns correct result when skills_log fails', async () => {
      const { skill, db } = makeSkill()
      db._insertValues.mockRejectedValue(new Error('DB connection lost'))

      const result = await skill.execute()

      expect(result.requeued).toBe(2)
      expect(result.found).toBe(2)
    })
  })

  // ----------------------------------------------------------
  // Duration timing
  // ----------------------------------------------------------

  describe('execute — timing', () => {
    it('returns a positive durationMs', async () => {
      const { skill } = makeSkill()

      const result = await skill.execute()

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })
})
