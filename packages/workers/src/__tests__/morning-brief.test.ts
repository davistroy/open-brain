import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MorningBriefSkill,
  truncateToSnippet,
  extractOpenLoops,
  extractTodayItems,
  formatEmailTriageSection,
  formatReferenceCalendars,
} from '../skills/morning-brief.js'
import type { MorningBriefResult, EmailTriageItem, CalendarEvent } from '../skills/morning-brief.js'
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

/** Email classification fixture data for overnight email tests */
const EMAIL_CLASSIFICATIONS_COUNTS = [
  { category: 'Financial & Banking', count: '3' },
  { category: 'Work & Office', count: '2' },
  { category: 'Social & Newsletters', count: '7' },
  { category: 'Shopping & Receipts', count: '5' },
]

const EMAIL_FINANCIAL_SUBJECTS = [
  { subject: 'Amex statement ready' },
  { subject: 'Bank alert: large transaction' },
  { subject: 'Anthropic receipt' },
]

const EMAIL_WORK_SUBJECTS = [
  { subject: 'CFA meeting update' },
  { subject: 'CGI project note' },
]

function makeMockDb(opts: {
  yesterday?: Array<{ id: string; content: string }>
  recent?: Array<{ content: string }>
  people?: Array<{ name: string; snippet: string }>
  evening?: Array<{ content: string }>
  emailCounts?: Array<{ category: string; count: string }> | null
  emailSubjects?: Record<string, Array<{ subject: string }>>
} = {}) {
  const yesterday = opts.yesterday ?? YESTERDAY_CAPTURES
  const recent = opts.recent ?? RECENT_CAPTURES_WITH_LOOPS
  const people = opts.people ?? PEOPLE_RESULTS
  const evening = opts.evening ?? EVENING_CAPTURES_WITH_TODAY

  // emailCounts: null = no email data (default for existing tests), array = has data
  const emailCounts = opts.emailCounts ?? null
  const emailSubjects = opts.emailSubjects ?? {}

  const executeMock = vi.fn()

  // queryOvernightEmail — first call is category counts
  executeMock.mockResolvedValueOnce({ rows: emailCounts ?? [] })

  // queryOvernightEmail — for each priority category, a subjects query
  if (emailCounts) {
    const priorityCategories = new Set([
      'Financial & Banking', 'Work & Office', 'Jamie', 'Ashley', 'Account & Security',
    ])
    for (const row of emailCounts) {
      if (priorityCategories.has(row.category)) {
        executeMock.mockResolvedValueOnce({
          rows: emailSubjects[row.category] ?? [],
        })
      }
    }
  }

  // Standard capture queries
  executeMock
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
  emailCounts?: Array<{ category: string; count: string }> | null
  emailSubjects?: Record<string, Array<{ subject: string }>>
  pushoverConfigured?: boolean
  slackChannelId?: string
  slackBotToken?: string
} = {}) {
  const db = makeMockDb(opts)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const skill = new MorningBriefSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    slackChannelId: opts.slackChannelId,
    slackBotToken: opts.slackBotToken,
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

  it('assembles all sections and sends Pushover', async () => {
    const { skill, pushover } = makeSkill()

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.yesterdayThread.length).toBe(3)
    expect(result.openLoops.length).toBeGreaterThan(0)
    expect(result.people.length).toBe(2)
    expect(result.todayItems.length).toBeGreaterThan(0)
    expect(result.referenceCalendar).toEqual([]) // no Composio key in test = empty
    expect(result.notificationSent).toBe(true)

    expect(pushover.send).toHaveBeenCalledOnce()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.title).toContain('Morning Brief')
    expect(call.title).toContain('April')
    expect(call.priority).toBe(0)
    expect(call.message).toContain("YESTERDAY'S THREAD:")
    expect(call.message).toContain('OPEN LOOPS:')
    expect(call.message).toContain('PEOPLE:')
    expect(call.message).toContain('REFERENCE CALENDARS:')
  })

  it('sends notification even when only reference calendars have content', async () => {
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

    // Reference calendars section is always included, so message is never empty
    expect(result.notificationSent).toBe(true)
    expect(pushover.send).toHaveBeenCalledOnce()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).toContain('REFERENCE CALENDARS:')
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
    expect(call.message).toContain('REFERENCE CALENDARS:')
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

    // All DB-sourced sections should be empty due to query failures
    expect(result.emailTriage).toEqual([])
    expect(result.yesterdayThread).toEqual([])
    expect(result.openLoops).toEqual([])
    expect(result.people).toEqual([])
    expect(result.todayItems).toEqual([])
    // Reference calendars section always present, so notification still sent
    expect(result.notificationSent).toBe(true)
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

  it('includes email triage section when email data exists', async () => {
    const { skill, pushover } = makeSkill({
      emailCounts: EMAIL_CLASSIFICATIONS_COUNTS,
      emailSubjects: {
        'Financial & Banking': EMAIL_FINANCIAL_SUBJECTS,
        'Work & Office': EMAIL_WORK_SUBJECTS,
      },
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.emailTriage.length).toBe(4)

    // Priority categories have isPriority=true and subjects
    const financial = result.emailTriage.find(e => e.category === 'Financial & Banking')
    expect(financial).toBeDefined()
    expect(financial!.isPriority).toBe(true)
    expect(financial!.count).toBe(3)
    expect(financial!.topSubjects).toHaveLength(3)
    expect(financial!.topSubjects[0]).toBe('Amex statement ready')

    const work = result.emailTriage.find(e => e.category === 'Work & Office')
    expect(work).toBeDefined()
    expect(work!.isPriority).toBe(true)
    expect(work!.count).toBe(2)

    // Non-priority categories have isPriority=false and no subjects
    const social = result.emailTriage.find(e => e.category === 'Social & Newsletters')
    expect(social).toBeDefined()
    expect(social!.isPriority).toBe(false)
    expect(social!.topSubjects).toEqual([])

    // Message includes OVERNIGHT EMAIL section
    expect(pushover.send).toHaveBeenCalled()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).toContain('OVERNIGHT EMAIL:')
    expect(call.message).toContain('Financial & Banking (3)')
    expect(call.message).toContain('Amex statement ready')
    expect(call.message).toContain('12 other emails auto-filed')
  })

  it('skips email triage section when no email data exists', async () => {
    const { skill, pushover } = makeSkill({
      emailCounts: null,
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.emailTriage).toEqual([])

    expect(pushover.send).toHaveBeenCalled()
    const call = vi.mocked(pushover.send).mock.calls[0][0]
    expect(call.message).not.toContain('OVERNIGHT EMAIL:')
  })

  it('includes email count in skills_log output_summary', async () => {
    const { skill, db } = makeSkill({
      emailCounts: EMAIL_CLASSIFICATIONS_COUNTS,
      emailSubjects: {
        'Financial & Banking': EMAIL_FINANCIAL_SUBJECTS,
        'Work & Office': EMAIL_WORK_SUBJECTS,
      },
    })

    await skill.execute({ now: FIXED_NOW })

    const insertChain = db.insert.mock.results[0].value
    const logEntry = insertChain.values.mock.calls[0][0]
    expect(logEntry.output_summary).toContain('email:17')
  })
})

// ============================================================
// Tests: formatEmailTriageSection
// ============================================================

describe('formatEmailTriageSection', () => {
  it('formats priority categories with subjects', () => {
    const items: EmailTriageItem[] = [
      { category: 'Financial & Banking', count: 3, topSubjects: ['Amex statement', 'Bank alert', 'Receipt'], isPriority: true },
    ]
    const result = formatEmailTriageSection(items)
    expect(result).toBe('OVERNIGHT EMAIL:\n- Financial & Banking (3): Amex statement, Bank alert, Receipt')
  })

  it('aggregates non-priority categories', () => {
    const items: EmailTriageItem[] = [
      { category: 'Social & Newsletters', count: 7, topSubjects: [], isPriority: false },
      { category: 'Shopping & Receipts', count: 5, topSubjects: [], isPriority: false },
    ]
    const result = formatEmailTriageSection(items)
    expect(result).toBe('OVERNIGHT EMAIL:\n- 12 other emails auto-filed')
  })

  it('handles mix of priority and non-priority', () => {
    const items: EmailTriageItem[] = [
      { category: 'Work & Office', count: 2, topSubjects: ['CFA meeting', 'CGI note'], isPriority: true },
      { category: 'Social & Newsletters', count: 7, topSubjects: [], isPriority: false },
    ]
    const result = formatEmailTriageSection(items)
    expect(result).toContain('Work & Office (2): CFA meeting, CGI note')
    expect(result).toContain('7 other emails auto-filed')
  })

  it('uses singular "email" for count of 1', () => {
    const items: EmailTriageItem[] = [
      { category: 'Misc', count: 1, topSubjects: [], isPriority: false },
    ]
    const result = formatEmailTriageSection(items)
    expect(result).toContain('1 other email auto-filed')
    expect(result).not.toContain('emails')
  })

  it('handles priority category with no subjects gracefully', () => {
    const items: EmailTriageItem[] = [
      { category: 'Account & Security', count: 1, topSubjects: [], isPriority: true },
    ]
    const result = formatEmailTriageSection(items)
    expect(result).toContain('Account & Security (1): (no subjects)')
  })
})

// ============================================================
// Tests: formatReferenceCalendars
// ============================================================

describe('formatReferenceCalendars', () => {
  it('shows "No events today" for empty reference calendars', () => {
    const result = formatReferenceCalendars([])
    expect(result).toContain('REFERENCE CALENDARS:')
    expect(result).toContain("Ashley's Calendar")
    expect(result).toContain('SCARS (Ham Radio)')
    expect(result).toContain('No events today')
  })

  it('shows events grouped by calendar name', () => {
    const events: CalendarEvent[] = [
      { time: '10:00 AM', title: 'Doctor appointment', calendar: "Ashley's Calendar" },
      { time: 'All day', title: 'Soccer tournament', calendar: "Ashley's Calendar" },
    ]
    const result = formatReferenceCalendars(events)
    expect(result).toContain("Ashley's Calendar")
    expect(result).toContain('10:00 AM Doctor appointment')
    expect(result).toContain('All day Soccer tournament')
    // SCARS should still show with "No events today"
    expect(result).toContain('SCARS (Ham Radio)')
    expect(result).toContain('No events today')
  })

  it('shows events for both calendars when both have events', () => {
    const events: CalendarEvent[] = [
      { time: '9:00 AM', title: 'Dentist', calendar: 'Ashley Davis' },
      { time: '7:00 PM', title: 'Net check-in', calendar: 'SCARS' },
    ]
    const result = formatReferenceCalendars(events)
    expect(result).toContain("Ashley's Calendar")
    expect(result).toContain('9:00 AM Dentist')
    expect(result).toContain('SCARS (Ham Radio)')
    expect(result).toContain('7:00 PM Net check-in')
    expect(result).not.toContain('No events today')
  })

  it('handles alternate calendar name "Ashley Davis"', () => {
    const events: CalendarEvent[] = [
      { time: '2:00 PM', title: 'Pick up kids', calendar: 'Ashley Davis' },
    ]
    const result = formatReferenceCalendars(events)
    expect(result).toContain("Ashley's Calendar")
    expect(result).toContain('2:00 PM Pick up kids')
  })
})

// ============================================================
// Tests: Slack DM delivery
// ============================================================

describe('MorningBriefSkill — Slack DM delivery', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.SLACK_BOT_TOKEN
    delete process.env.MORNING_BRIEF_SLACK_CHANNEL
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockSlackFetch() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true }),
      text: vi.fn().mockResolvedValue(''),
    })
    globalThis.fetch = fetchMock
    return fetchMock
  }

  it('sends Slack DM when token and channel are configured', async () => {
    const fetchMock = mockSlackFetch()
    const { skill } = makeSkill({
      slackBotToken: 'xoxb-test-token',
      slackChannelId: 'D0AR39RNG4E',
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.slackSent).toBe(true)
    const slackCalls = fetchMock.mock.calls.filter(
      (c: [string, ...unknown[]]) => typeof c[0] === 'string' && c[0].includes('slack.com'),
    )
    expect(slackCalls.length).toBe(1)

    const body = JSON.parse(slackCalls[0][1].body)
    expect(body.channel).toBe('D0AR39RNG4E')
    expect(body.blocks).toBeDefined()
    expect(body.blocks.length).toBeGreaterThan(0)
    expect(body.blocks[0].type).toBe('header')
    expect(body.blocks[0].text.text).toContain('Morning Brief')
  })

  it('does not send Slack DM when token is missing', async () => {
    const fetchMock = mockSlackFetch()
    const { skill } = makeSkill({
      slackChannelId: 'D0AR39RNG4E',
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.slackSent).toBe(false)
    const slackCalls = fetchMock.mock.calls.filter(
      (c: [string, ...unknown[]]) => typeof c[0] === 'string' && c[0].includes('slack.com'),
    )
    expect(slackCalls.length).toBe(0)
  })

  it('does not send Slack DM when channel ID is missing', async () => {
    mockSlackFetch()
    const { skill } = makeSkill({
      slackBotToken: 'xoxb-test-token',
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.slackSent).toBe(false)
  })

  it('sends Slack DM even when capture sections are empty (reference calendars always present)', async () => {
    mockSlackFetch()
    const { skill } = makeSkill({
      yesterday: [],
      recent: [{ content: 'Nothing interesting.' }],
      people: [],
      evening: [],
      slackBotToken: 'xoxb-test-token',
      slackChannelId: 'D0AR39RNG4E',
    })

    const result = await skill.execute({ now: FIXED_NOW })

    // Reference calendars always produce output, so message is never empty
    expect(result.slackSent).toBe(true)
  })

  it('handles Slack send failure gracefully — still logs to skills_log', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Slack network error'))
    const { skill, db } = makeSkill({
      slackBotToken: 'xoxb-test-token',
      slackChannelId: 'D0AR39RNG4E',
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.slackSent).toBe(false)
    expect(result.notificationSent).toBe(true)
    expect(db.insert).toHaveBeenCalledOnce()
  })

  it('sends both Pushover and Slack independently', async () => {
    mockSlackFetch()
    const { skill, pushover } = makeSkill({
      slackBotToken: 'xoxb-test-token',
      slackChannelId: 'D0AR39RNG4E',
    })

    const result = await skill.execute({ now: FIXED_NOW })

    expect(result.notificationSent).toBe(true)
    expect(result.slackSent).toBe(true)
    expect(pushover.send).toHaveBeenCalledOnce()
  })

  it('includes slackSent in skills_log output_summary', async () => {
    mockSlackFetch()
    const { skill, db } = makeSkill({
      slackBotToken: 'xoxb-test-token',
      slackChannelId: 'D0AR39RNG4E',
    })

    await skill.execute({ now: FIXED_NOW })

    const insertChain = db.insert.mock.results[0].value
    const logEntry = insertChain.values.mock.calls[0][0]
    expect(logEntry.output_summary).toContain('slack:true')
    expect(logEntry.output_summary).toContain('pushover:true')
  })
})

// ============================================================
// Tests: Slack Block Kit formatting
// ============================================================

describe('MorningBriefSkill — formatSlackBlocks', () => {
  // Reference calendars are always shown, so minimum blocks = header + divider + refCal section = 3
  const BASELINE_BLOCKS = 3

  it('generates header block with title', () => {
    const { skill } = makeSkill()
    const blocks = skill.formatSlackBlocks(
      'Morning Brief \u2014 April 9',
      [], [], [], [], [], [], [],
    )

    expect(blocks.length).toBe(BASELINE_BLOCKS)
    expect(blocks[0].type).toBe('header')
    expect(blocks[0].text!.text).toContain('Morning Brief')
  })

  it('always includes reference calendars section', () => {
    const { skill } = makeSkill()
    const blocks = skill.formatSlackBlocks(
      'Test',
      [], [], [], [], [], [], [],
    )

    const refCalBlock = blocks.find(b => b.text?.text?.includes('Reference Calendars'))
    expect(refCalBlock).toBeDefined()
    expect(refCalBlock!.text!.text).toContain('No events today')
  })

  it('generates schedule section with bold times', () => {
    const { skill } = makeSkill()
    const blocks = skill.formatSlackBlocks(
      'Test',
      [{ time: '9:00 AM', title: 'Standup', calendar: 'Work' }],
      [], [], [], [], [], [],
    )

    // header + divider + schedule + divider + refCal = 5
    expect(blocks.length).toBe(BASELINE_BLOCKS + 2)
    const scheduleBlock = blocks[2]
    expect(scheduleBlock.type).toBe('section')
    expect(scheduleBlock.text!.text).toContain("*:calendar: Today's Schedule*")
    expect(scheduleBlock.text!.text).toContain('*9:00 AM*')
    expect(scheduleBlock.text!.text).toContain('Standup')
  })

  it('generates email triage section for priority items', () => {
    const { skill } = makeSkill()
    const blocks = skill.formatSlackBlocks(
      'Test',
      [], [],
      [
        { category: 'Financial & Banking', count: 3, topSubjects: ['Amex statement'], isPriority: true },
        { category: 'Social', count: 5, topSubjects: [], isPriority: false },
      ],
      [], [], [], [],
    )

    const emailBlock = blocks.find(b => b.text?.text?.includes('Overnight Email'))
    expect(emailBlock).toBeDefined()
    expect(emailBlock!.text!.text).toContain('*Financial & Banking*')
    expect(emailBlock!.text!.text).toContain('5 other emails auto-filed')
  })

  it('generates thread, loops, people, and today sections', () => {
    const { skill } = makeSkill()
    const blocks = skill.formatSlackBlocks(
      'Test',
      [], [], [],
      [{ id: 'cap-1', snippet: 'Worked on pipeline' }],
      ['Need to fix the build'],
      [{ name: 'Joe', snippet: 'KB approval' }],
      ['Thursday morning meeting'],
    )

    const text = blocks.map(b => b.text?.text ?? '').join('\n')
    expect(text).toContain("Yesterday's Thread")
    expect(text).toContain('Worked on pipeline')
    expect(text).toContain('Open Loops')
    expect(text).toContain('Need to fix the build')
    expect(text).toContain('People')
    expect(text).toContain('*Joe*')
    expect(text).toContain('Today')
    expect(text).toContain('Thursday morning meeting')
  })

  it('has only header + refCal when all optional sections empty', () => {
    const { skill } = makeSkill()
    const blocks = skill.formatSlackBlocks(
      'Test',
      [], [], [], [], [], [], [],
    )

    expect(blocks.length).toBe(BASELINE_BLOCKS)
    expect(blocks[0].type).toBe('header')
    expect(blocks[1].type).toBe('divider')
    expect(blocks[2].type).toBe('section')
  })

  it('uses dividers between sections', () => {
    const { skill } = makeSkill()
    const blocks = skill.formatSlackBlocks(
      'Test',
      [{ time: '9:00 AM', title: 'Meeting', calendar: 'Work' }],
      [], [],
      [{ id: 'cap-1', snippet: 'Item' }],
      [], [], [],
    )

    const dividers = blocks.filter(b => b.type === 'divider')
    // schedule divider + refCal divider + thread divider = 3
    expect(dividers.length).toBe(3)
  })
})
