import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PipelineHealthSkill } from '../skills/pipeline-health.js'

// ============================================================
// Helpers
// ============================================================

function makeMockQueueFactory() {
  return (name: string) => ({
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0, delayed: 0, paused: 0 }),
    getJobCountByTypes: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  })
}

function makeMockDb(captureCount: string = '5') {
  // The db.execute mock needs to handle two different queries:
  // 1. pipeline_events failure query (returns rows array)
  // 2. capture flow COUNT query (returns { count: string })
  // We differentiate by call order: first call = pipeline_events, second = capture flow
  const executeMock = vi.fn()
    .mockResolvedValueOnce({ rows: [] })  // pipeline_events query
    .mockResolvedValueOnce({ rows: [{ count: captureCount }] })  // capture flow query

  return {
    execute: executeMock,
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  }
}

// ============================================================
// Tests
// ============================================================

describe('PipelineHealthSkill — heartbeat (capture flow)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('executes without errors with mock queues', async () => {
    const mockDb = makeMockDb('5')

    const skill = new PipelineHealthSkill({
      db: mockDb as any,
      queueFactory: makeMockQueueFactory(),
      pushover: { isConfigured: false, send: vi.fn() } as any,
    })

    const result = await skill.execute()
    expect(result.healthy).toBe(true)
    expect(result.alertSent).toBe(false)
    expect(typeof result.durationMs).toBe('number')
  })

  it('includes captureFlowStale field in result', async () => {
    const mockDb = makeMockDb('10')

    const skill = new PipelineHealthSkill({
      db: mockDb as any,
      queueFactory: makeMockQueueFactory(),
      pushover: { isConfigured: false, send: vi.fn() } as any,
    })

    const result = await skill.execute()
    expect(typeof result.captureFlowStale).toBe('boolean')
  })

  it('detects when no captures have flowed recently (during active hours)', async () => {
    // Mock Date to return 10am (active hours)
    const mockDate = new Date('2026-04-02T10:00:00')
    vi.setSystemTime(mockDate)

    const mockDb = makeMockDb('0')

    const skill = new PipelineHealthSkill({
      db: mockDb as any,
      queueFactory: makeMockQueueFactory(),
      pushover: { isConfigured: true, send: vi.fn().mockResolvedValue(undefined) } as any,
    })

    const result = await skill.execute()
    expect(result.captureFlowStale).toBe(true)

    vi.useRealTimers()
  })

  it('skips capture flow check during quiet hours (midnight-7am)', async () => {
    // Mock Date to return 3am (quiet hours)
    const mockDate = new Date('2026-04-02T03:00:00')
    vi.setSystemTime(mockDate)

    // Return 0 captures — but it should not matter during quiet hours
    const mockDb = makeMockDb('0')

    const skill = new PipelineHealthSkill({
      db: mockDb as any,
      queueFactory: makeMockQueueFactory(),
      pushover: { isConfigured: false, send: vi.fn() } as any,
    })

    const result = await skill.execute()
    // captureFlowStale should be false because the check is skipped
    expect(result.captureFlowStale).toBe(false)

    vi.useRealTimers()
  })

  it('includes capture flow stale message in Pushover alert', async () => {
    // Mock Date to return 10am (active hours)
    const mockDate = new Date('2026-04-02T10:00:00')
    vi.setSystemTime(mockDate)

    const sendMock = vi.fn().mockResolvedValue(undefined)
    const mockDb = makeMockDb('0')

    const skill = new PipelineHealthSkill({
      db: mockDb as any,
      queueFactory: makeMockQueueFactory(),
      pushover: { isConfigured: true, send: sendMock } as any,
    })

    await skill.execute()

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('No captures received in the last 6 hours'),
      }),
    )

    vi.useRealTimers()
  })

  it('treats capture flow check DB errors as non-fatal (assumes OK)', async () => {
    // Mock Date to return 10am (active hours)
    const mockDate = new Date('2026-04-02T10:00:00')
    vi.setSystemTime(mockDate)

    const executeMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })  // pipeline_events query
      .mockRejectedValueOnce(new Error('DB connection lost'))  // capture flow query fails

    const mockDb = {
      execute: executeMock,
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    }

    const skill = new PipelineHealthSkill({
      db: mockDb as any,
      queueFactory: makeMockQueueFactory(),
      pushover: { isConfigured: false, send: vi.fn() } as any,
    })

    const result = await skill.execute()
    // Should not crash, and should assume OK (not stale)
    expect(result.captureFlowStale).toBe(false)
    expect(result.healthy).toBe(true)

    vi.useRealTimers()
  })
})
