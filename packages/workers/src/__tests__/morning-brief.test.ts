import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MorningBriefSkill,
  truncateToSnippet,
  extractOpenLoops,
  extractTodayItems,
} from '../skills/morning-brief.js'
import type { MorningBriefResult } from '../skills/morning-brief.js'
import { PushoverService } from '../services/pushover.js'

// ============================================================
// Fixtures
// ============================================================

/** Thursday April 9 2026 at 7:15 AM */
const FIXED_NOW = new Date('2026-04-09T07:15:00.000-04:00')

const YESTERDAY_CAPTURES = [
  { id: 'cap-1', content: 'KB analysis update worked up nicely. The scoring model is producing useful results now.' },
  { id: 'cap-2', content: 'Sent AI workshop emails to the distribution list.' },
  { id: 'cap-3', content: 'Got feedback from Chris Thomas on the proposal. Looks good overall.' },
]

const RECENT_CAPTURES_WITH_LOOPS = [
  { content: 'Need to get Joe Hartman approval on the KB migration plan before Friday.' },
  { content: 'Waiting on Andy Washington to confirm the PMO timeline.' },
  { content: 'The voice pipeline is working well now. Should look at latency metrics next.' },
  { content: 'Regular work with no forward-looking items here.' },
]

const PEOPLE_RESULTS = [
  { name: 'Joe Hartman', snippet: 'Need to get Joe Hartman approval on the KB migration plan' },
  { name: 'Chris Thomas', snippet: 'Got feedback from Chris Thomas on the proposal' },
]

const EVENING_CAPTURES_WITH_TODAY = [
  { content: 'Tomorrow I have the AI workshops at 10 AM. Need to prepare slides.' },
  { content: 'Thursday morning meeting with the ops team about the new dashboard.' },
]

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(opts: {
  yesterday?: Array<{ id: string; content: string }>
  recent?: Array<{ content: string }>
  people?: Array<{ name: string; snippet: string }>
  evening?: Array<{ content: string }>
} = {}) {
  const yesterday = opts.yesterday ?? YESTERDAY_CAPTURES
  const recent = opts.recent ?? RECENT_CAPTURES_WITH_LOOPS
  const people = opts.people ?? PEOPLE_RESULTS
  const evening = opts.evening ?? EVENING_CAPTURES_WITH_TODAY

  const executeMock = vi.fn()
    .mockResolvedValueOnce({ rows: yesterday })   // queryYesterdayCaptures
    .mockResolvedValueOnce({ rows: recent })       // queryRecentCaptures
    .mockResolvedValueOnce({ rows: people })       // queryRecentPeople
    .mockResolvedValueOnce({ rows: evening })      // queryEveningCaptures

  return {
    execute: executeMock,
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

function makeSkill(opts: {
  yesterday?: Array<{ id: string; content: string }>
  recent?: Array<{ content: string }>
  people?: Array<{ name: string; snippet: string }>
  evening?: Array<{ content: string }>
  pushoverConfigured?: boolean
} = {}) {
  const db = makeMockDb(opts)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const skill = new MorningBriefSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests: truncateToSnippet
// ============================================================

describe('truncateToSnippet', () => {
  it('returns full text when shorter than maxLen', () => {
    expect(truncateToSnippet('Short text.')).toBe('Short text.')
  })

  it('truncates at first sentence boundary', () => {
    const input = 'First sentence. Second sentence goes here.'
    expect(truncateToSnippet(input)).toBe('First sentence.')
  })

  it('truncates at maxLen when no sentence boundary', () => {
    const input = 'A'.repeat(200)
    expect(truncateToSnippet(input, 100)).toBe('A'.repeat(100) + '...')
  })

  it('respects custom maxLen', () => {
    const input = 'Word '.repeat(20)
    const result = truncateToSnippet(input.trim(), 30)
    expect(result.length).toBeLessThanOrEqual(33) // 30 + '...'
  })
})

// ============================================================
// Tests: extractOpenLoops
// ============================================================

describe('extractOpenLoops', () => {
  it('extracts sentences with forward-looking phrases', () => {
    const loops = extractOpenLoops(RECENT_CAPTURES_WITH_LOOPS)
    expect(loops.length).toBeGreaterThan(0)
    expect(loops.some(l => l.toLowerCase().includes('need to'))).toBe(true)
    expect(loops.some(l => l.toLowerCase().includes('waiting on'))).toBe(true)
  })

  it('returns at most 5 items', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      content: `Need to do item ${i}. This is a task.`,
    }))
    const loops = extractOpenLoops(many)
    expect(loops.length).toBeLessThanOrEqual(5)
  })

  it('deduplicates identical sentences', () => {
    const dupes = [
      { content: 'Need to fix the build. Need to fix the build.' },
      { content: 'Need to fix the build.' },
    ]
    const loops = extractOpenLoops(dupes)
    expect(loops.length).toBe(1)
  })

  it('returns empty array when no forward-looking phrases', () => {
    const captures = [
      { content: 'Had a great day at the office.' },
      { content: 'The weather was nice.' },
    ]
    expect(extractOpenLoops(captures)).toEqual([])
  })

  it('skips very short fragments', () => {
    const captures = [{ content: 'Need to.' }]
    expect(extractOpenLoops(captures)).toEqual([])
  })
})

// ============================================================
// Tests: extractTodayItems
// ============================================================

describe('extractTodayItems', () => {
  it('finds mentions of today day name', () => {
    // FIXED_NOW is Thursday
    const items = extractTodayItems(EVENING_CAPTURES_WITH_TODAY, FIXED_NOW)
    expect(items.some(i => i.toLowerCase().includes('thursday'))).toBe(true)
  })

  it('finds mentions of "tomorrow"', () => {
    const items = extractTodayItems(EVENING_CAPTURES_WITH_TODAY, FIXED_NOW)
    expect(items.some(i => i.toLowerCase().includes('tomorrow'))).toBe(true)
  })

  it('returns empty array when no day references', () => {
    const captures = [{ content: 'Regular update about the project status.' }]
    expect(extractTodayItems(captures, FIXED_NOW)).toEqual([])
  })

  it('deduplicates identical sentences', () => {
    const dupes = [
      { content: 'Meeting on Thursday at noon.' },
      { content: 'Meeting on Thursday at noon.' },
    ]
    const items = extractTodayItems(dupes, FIXED_NOW)
    expect(items.length).toBe(1)
  })
})

// ============================================================
// Tests: MorningBriefSkill — full execute flow
// ============================================================

describe('MorningBriefSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('assembles all four sections and sends Pushover', async () => {
    const { skill, pushover } = makeSkill()

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.yesterdayThread.length).toBe(3)
    expect(result.openLoops.length).toBeGreaterThan(0)
    expect(result.people.length).toBe(2)
    expect(result.todayItems.length).toBeGreaterThan(0)
    expect(result.notificationSent).toBe(true)

    expect(pushover.send).toHaveBeenCalledOnce()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.title).toContain('Morning Brief')
    expect(call.title).toContain('April')
    expect(call.priority).toBe(0)
    expect(call.message).toContain("YESTERDAY'S THREAD:")
    expect(call.message).toContain('OPEN LOOPS:')
    expect(call.message).toContain('PEOPLE:')
  })

  it('omits empty sections from message', async () => {
    const { skill, pushover } = makeSkill({
      yesterday: [],
      recent: [{ content: 'Just regular notes.' }],
      people: [],
      evening: [],
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.yesterdayThread.length).toBe(0)
    expect(result.openLoops.length).toBe(0)
    expect(result.people.length).toBe(0)
    expect(result.todayItems.length).toBe(0)

    // All sections empty — no notification sent
    expect(result.notificationSent).toBe(false)
    expect(pushover.send).not.toHaveBeenCalled()
  })

  it('sends notification with partial sections', async () => {
    const { skill, pushover } = makeSkill({
      yesterday: YESTERDAY_CAPTURES,
      recent: [{ content: 'No forward-looking text here.' }],
      people: [],
      evening: [],
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.yesterdayThread.length).toBe(3)
    expect(result.openLoops.length).toBe(0)
    expect(result.people.length).toBe(0)
    expect(result.todayItems.length).toBe(0)
    expect(result.notificationSent).toBe(true)

    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).toContain("YESTERDAY'S THREAD:")
    expect(call.message).not.toContain('OPEN LOOPS:')
    expect(call.message).not.toContain('PEOPLE:')
    expect(call.message).not.toContain('TODAY:')
  })

  it('logs to skills_log with full result', async () => {
    const { skill, db } = makeSkill()

    await skill.execute({ now: FIXED_NOW })

    expect(db.insert).toHaveBeenCalledOnce()
    const insertChain = db.insert.mock.results[0].value
    expect(insertChain.values).toHaveBeenCalledOnce()

    const logEntry = insertChain.values.mock.calls[0][0]
    expect(logEntry.skill_name).toBe('morning-brief')
    expect(logEntry.capture_id).toBeNull()
    expect(logEntry.input_summary).toContain('date:')
    expect(logEntry.output_summary).toContain('thread:3')
    expect(logEntry.output_summary).toContain('loops:')
    expect(logEntry.output_summary).toContain('people:2')
    expect(logEntry.result).toBeDefined()
    expect(logEntry.result.yesterdayThread).toHaveLength(3)
  })

  it('does not create a capture', async () => {
    const { skill, db } = makeSkill()

    await skill.execute({ now: FIXED_NOW })

    // Only one insert call (skills_log), no capture insertion
    expect(db.insert).toHaveBeenCalledOnce()
  })

  it('handles Pushover not configured gracefully', async () => {
    const { skill } = makeSkill({ pushoverConfigured: false })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.notificationSent).toBe(false)
  })

  it('handles Pushover send failure gracefully', async () => {
    const { skill, pushover } = makeSkill()
    vi.mocked(pushover.send).mockRejectedValueOnce(new Error('Pushover API 500'))

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.notificationSent).toBe(false)
    // Should still log to skills_log
  })

  it('handles database query failure gracefully', async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error('Connection refused')),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    }
    const pushover = makePushoverService()
    const skill = new MorningBriefSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
    })

    const result = await skill.execute({ now: FIXED_NOW })

    // All sections should be empty due to query failures
    expect(result.yesterdayThread).toEqual([])
    expect(result.openLoops).toEqual([])
    expect(result.people).toEqual([])
    expect(result.todayItems).toEqual([])
    expect(result.notificationSent).toBe(false)
  })

  it('truncates yesterday thread items to first sentence or 100 chars', async () => {
    const longContent = 'A'.repeat(200)
    const { skill } = makeSkill({
      yesterday: [{ id: 'cap-long', content: longContent }],
      recent: [],
      people: [],
      evening: [],
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.yesterdayThread[0].snippet.length).toBeLessThanOrEqual(103) // 100 + '...'
  })

  it('excludes self-references from people section via SQL', async () => {
    // The SQL query itself excludes Troy Davis / Troy — test that the people results
    // are passed through as-is (the filtering happens at the DB level)
    const { skill } = makeSkill({
      people: [{ name: 'Joe Hartman', snippet: 'KB approval discussion' }],
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.people.length).toBe(1)
    expect(result.people[0].name).toBe('Joe Hartman')
  })
})
