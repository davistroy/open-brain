import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureReminderSkill } from '../skills/capture-reminder.js'
import { PushoverService } from '../services/pushover.js'

// ============================================================
// Fixtures
// ============================================================

/** Thursday April 9 2026 at 9:00 PM */
const FIXED_NOW = new Date('2026-04-09T21:00:00.000-04:00')

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(opts: {
  captureCount?: number
  lastCaptureAt?: string | null
  queryError?: boolean
  insertError?: boolean
} = {}) {
  const count = opts.captureCount ?? 0
  const lastAt = opts.lastCaptureAt ?? null

  const executeMock = opts.queryError
    ? vi.fn().mockRejectedValue(new Error('Connection refused'))
    : vi.fn().mockResolvedValue({
        rows: [{ count: String(count), last_at: lastAt }],
      })

  const returningMock = opts.insertError
    ? vi.fn().mockRejectedValue(new Error('Insert failed'))
    : vi.fn().mockResolvedValue([{ id: 'mock-log-id' }])

  return {
    execute: executeMock,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: returningMock }),
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

function makeSkill(opts: {
  captureCount?: number
  lastCaptureAt?: string | null
  queryError?: boolean
  insertError?: boolean
  pushoverConfigured?: boolean
} = {}) {
  const db = makeMockDb(opts)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const skill = new CaptureReminderSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests: CaptureReminderSkill
// ============================================================

describe('CaptureReminderSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------
  // Morning mode
  // ----------------------------------------------------------

  it('morning mode sends correct Pushover message', async () => {
    const { skill, pushover, db } = makeSkill()

    const result = await skill.execute({ mode: 'morning', now: FIXED_NOW })

    expect(result.mode).toBe('morning')
    expect(result.notificationSent).toBe(true)
    expect(result.captureCount).toBeUndefined()
    expect(result.lastCaptureAt).toBeUndefined()

    expect(pushover.send).toHaveBeenCalledOnce()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.title).toBe('Open Brain')
    expect(call.message).toBe("What's on your plate today?")
    expect(call.priority).toBe(-1)

    // Morning mode should NOT query the database for captures
    expect(db.execute).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------
  // Evening mode — with captures
  // ----------------------------------------------------------

  it('evening mode with captures sends count and last time', async () => {
    const lastAt = '2026-04-09T18:30:00.000Z'
    const { skill, pushover } = makeSkill({
      captureCount: 5,
      lastCaptureAt: lastAt,
    })

    const result = await skill.execute({ mode: 'evening', now: FIXED_NOW })

    expect(result.mode).toBe('evening')
    expect(result.notificationSent).toBe(true)
    expect(result.captureCount).toBe(5)
    expect(result.lastCaptureAt).toBe(lastAt)

    expect(pushover.send).toHaveBeenCalledOnce()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).toMatch(/5 captures today/)
    expect(call.message).toContain('How did the day go?')
  })

  it('evening mode with 1 capture uses singular form', async () => {
    const { skill, pushover } = makeSkill({
      captureCount: 1,
      lastCaptureAt: '2026-04-09T14:00:00.000Z',
    })

    const result = await skill.execute({ mode: 'evening', now: FIXED_NOW })

    expect(result.captureCount).toBe(1)
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).toMatch(/1 capture today/)
    expect(call.message).not.toMatch(/1 captures/)
  })

  // ----------------------------------------------------------
  // Evening mode — zero captures
  // ----------------------------------------------------------

  it('evening mode with zero captures shows "No captures today"', async () => {
    const { skill, pushover } = makeSkill({
      captureCount: 0,
      lastCaptureAt: null,
    })

    const result = await skill.execute({ mode: 'evening', now: FIXED_NOW })

    expect(result.mode).toBe('evening')
    expect(result.notificationSent).toBe(true)
    expect(result.captureCount).toBe(0)

    expect(pushover.send).toHaveBeenCalledOnce()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).toBe('No captures today. How did the day go?')
  })

  // ----------------------------------------------------------
  // DB query failure is non-fatal
  // ----------------------------------------------------------

  it('DB query failure is non-fatal — skill returns gracefully', async () => {
    const { skill, pushover } = makeSkill({ queryError: true })

    const result = await skill.execute({ mode: 'evening', now: FIXED_NOW })

    // Should default to 0 captures and still send notification
    expect(result.captureCount).toBe(0)
    expect(result.lastCaptureAt).toBeNull()
    expect(result.notificationSent).toBe(true)

    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).toBe('No captures today. How did the day go?')
  })

  // ----------------------------------------------------------
  // Pushover not configured is non-fatal
  // ----------------------------------------------------------

  it('Pushover not configured is non-fatal', async () => {
    const { skill, pushover } = makeSkill({ pushoverConfigured: false })

    const result = await skill.execute({ mode: 'morning', now: FIXED_NOW })

    expect(result.notificationSent).toBe(false)
    expect(pushover.send).not.toHaveBeenCalled()
    // Skill should complete without error
    expect(result.mode).toBe('morning')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('Pushover send failure is non-fatal', async () => {
    const { skill, pushover } = makeSkill()
    vi.mocked(pushover.send).mockRejectedValueOnce(new Error('Pushover API 500'))

    const result = await skill.execute({ mode: 'morning', now: FIXED_NOW })

    expect(result.notificationSent).toBe(false)
    // Skill should still complete and log to skills_log
  })

  // ----------------------------------------------------------
  // Skills_log entry is created
  // ----------------------------------------------------------

  it('skills_log entry is created', async () => {
    const { skill, db } = makeSkill({ captureCount: 3, lastCaptureAt: '2026-04-09T15:00:00Z' })

    await skill.execute({ mode: 'evening', now: FIXED_NOW })

    expect(db.insert).toHaveBeenCalledOnce()
    const insertChain = db.insert.mock.results[0].value
    expect(insertChain.values).toHaveBeenCalledOnce()

    const logEntry = insertChain.values.mock.calls[0][0]
    expect(logEntry.skill_name).toBe('capture-reminder-evening')
    expect(logEntry.capture_id).toBeNull()
    expect(logEntry.input_summary).toBe('mode:evening')
    expect(logEntry.output_summary).toContain('sent:true')
    expect(logEntry.output_summary).toContain('captures:3')
    expect(logEntry.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('skills_log entry is created for morning mode', async () => {
    const { skill, db } = makeSkill()

    await skill.execute({ mode: 'morning', now: FIXED_NOW })

    expect(db.insert).toHaveBeenCalledOnce()
    const insertChain = db.insert.mock.results[0].value
    const logEntry = insertChain.values.mock.calls[0][0]
    expect(logEntry.skill_name).toBe('capture-reminder-morning')
    expect(logEntry.input_summary).toBe('mode:morning')
  })

  it('skills_log write failure is non-fatal', async () => {
    const { skill } = makeSkill({ insertError: true })

    // Should not throw even if skills_log insert fails
    const result = await skill.execute({ mode: 'morning', now: FIXED_NOW })
    expect(result.notificationSent).toBe(true)
  })

  // ----------------------------------------------------------
  // now injection works correctly
  // ----------------------------------------------------------

  it('uses injected now for evening query instead of system clock', async () => {
    const customNow = new Date('2026-05-15T21:00:00.000-04:00')
    const { skill, db } = makeSkill({ captureCount: 2, lastCaptureAt: '2026-05-15T10:00:00Z' })

    await skill.execute({ mode: 'evening', now: customNow })

    // Verify the SQL query was called — the todayStart should be based on customNow
    expect(db.execute).toHaveBeenCalledOnce()
  })
})
