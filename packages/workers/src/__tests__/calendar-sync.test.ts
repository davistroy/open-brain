import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// CalendarSyncService — interface contract tests
//
// CalendarSyncService is the planned implementation for PRD F25 (calendar integration).
// It parses iCalendar (.ics) feeds/files and creates captures for each event.
//
// Planned behaviour:
//   CalendarSyncService.syncFeed(icsText) →
//     1. Parse iCal text into events (VEVENT blocks)
//     2. Extract: UID, DTSTART, DTEND, SUMMARY, DESCRIPTION, LOCATION
//     3. Create one capture per event with source='calendar'
//     4. Dedup by UID — skip events already present in DB
//     5. Return { created, skipped, errors }
//
// These tests mock the parse/DB layer to validate orchestration logic
// and the iCal parsing helpers independently.
// ---------------------------------------------------------------------------

// ── iCal parsing helpers ─────────────────────────────────────────────────────

interface CalendarEvent {
  uid: string
  summary: string
  description: string
  location: string
  dtstart: string   // ISO 8601 string
  dtend: string     // ISO 8601 string
  allDay: boolean
}

/**
 * Minimal iCal VEVENT parser — extracts the fields Open Brain cares about.
 * Real implementation will use a library (ical.js or node-ical).
 * This test-double parser covers the contract tests need to validate.
 */
function parseICalEvents(icsText: string): CalendarEvent[] {
  const events: CalendarEvent[] = []

  // Split into VEVENT blocks
  const veventPattern = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g
  let match: RegExpExecArray | null

  while ((match = veventPattern.exec(icsText)) !== null) {
    const block = match[1]

    const get = (key: string): string => {
      // Handles both KEY:value and KEY;params:value
      const lineMatch = block.match(new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, 'm'))
      return lineMatch ? lineMatch[1].trim() : ''
    }

    const uid = get('UID')
    const summary = get('SUMMARY')
    const description = get('DESCRIPTION')
    const location = get('LOCATION')
    const dtstartRaw = get('DTSTART')
    const dtendRaw = get('DTEND')

    // DTSTART;VALUE=DATE:20240315 → all-day event
    const allDay = /DTSTART;VALUE=DATE/.test(block)

    // Parse date or datetime to ISO 8601
    const parseICalDate = (raw: string): string => {
      if (!raw) return ''
      // YYYYMMDDTHHmmssZ → ISO
      const dtMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
      if (dtMatch) {
        const [, y, mo, d, h, mi, s, z] = dtMatch
        return `${y}-${mo}-${d}T${h}:${mi}:${s}${z === 'Z' ? 'Z' : ''}`
      }
      // YYYYMMDD → date only
      const dateMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
      if (dateMatch) {
        const [, y, mo, d] = dateMatch
        return `${y}-${mo}-${d}`
      }
      return raw
    }

    events.push({
      uid,
      summary,
      description,
      location,
      dtstart: parseICalDate(dtstartRaw),
      dtend: parseICalDate(dtendRaw),
      allDay,
    })
  }

  return events
}

// ── CalendarSyncService test-double factory ───────────────────────────────────

interface SyncResult {
  created: number
  skipped: number
  errors: number
}

function makeCalendarSyncService(overrides: {
  existingUids?: Set<string>
  insertCapture?: (event: CalendarEvent, brainView: string) => Promise<{ id: string }>
}) {
  const { existingUids = new Set(), insertCapture } = overrides

  return {
    /**
     * Sync a full iCal feed. Returns created/skipped/error counts.
     */
    syncFeed: async (icsText: string, brainView = 'personal'): Promise<SyncResult> => {
      const events = parseICalEvents(icsText)

      let created = 0
      let skipped = 0
      let errors = 0

      for (const event of events) {
        if (!event.uid) {
          errors++
          continue
        }

        // Dedup by UID
        if (existingUids.has(event.uid)) {
          skipped++
          continue
        }

        try {
          if (insertCapture) {
            await insertCapture(event, brainView)
          }
          existingUids.add(event.uid) // mark as seen
          created++
        } catch (err) {
          errors++
        }
      }

      return { created, skipped, errors }
    },
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SIMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-001@example.com
SUMMARY:Team standup
DESCRIPTION:Daily 15-minute sync
LOCATION:Zoom
DTSTART:20240315T090000Z
DTEND:20240315T091500Z
END:VEVENT
END:VCALENDAR`

const MULTI_EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-alpha@example.com
SUMMARY:Planning session
DTSTART:20240316T100000Z
DTEND:20240316T110000Z
END:VEVENT
BEGIN:VEVENT
UID:event-beta@example.com
SUMMARY:Design review
DESCRIPTION:Review mockups
DTSTART:20240317T140000Z
DTEND:20240317T150000Z
END:VEVENT
BEGIN:VEVENT
UID:event-gamma@example.com
SUMMARY:All-hands meeting
DTSTART:20240318T090000Z
DTEND:20240318T100000Z
END:VEVENT
END:VCALENDAR`

const ALL_DAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:allday-001@example.com
SUMMARY:Company holiday
DTSTART;VALUE=DATE:20240401
DTEND;VALUE=DATE:20240402
END:VEVENT
END:VCALENDAR`

const DUPLICATE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-dup@example.com
SUMMARY:Already captured
DTSTART:20240320T100000Z
DTEND:20240320T110000Z
END:VEVENT
END:VCALENDAR`

// ── iCal parsing tests ───────────────────────────────────────────────────────

describe('parseICalEvents — basic parsing', () => {
  it('parses a single VEVENT block', () => {
    const events = parseICalEvents(SIMPLE_ICS)
    expect(events).toHaveLength(1)
  })

  it('extracts UID correctly', () => {
    const [event] = parseICalEvents(SIMPLE_ICS)
    expect(event.uid).toBe('event-001@example.com')
  })

  it('extracts SUMMARY correctly', () => {
    const [event] = parseICalEvents(SIMPLE_ICS)
    expect(event.summary).toBe('Team standup')
  })

  it('extracts DESCRIPTION correctly', () => {
    const [event] = parseICalEvents(SIMPLE_ICS)
    expect(event.description).toBe('Daily 15-minute sync')
  })

  it('extracts LOCATION correctly', () => {
    const [event] = parseICalEvents(SIMPLE_ICS)
    expect(event.location).toBe('Zoom')
  })

  it('parses DTSTART as ISO 8601', () => {
    const [event] = parseICalEvents(SIMPLE_ICS)
    expect(event.dtstart).toBe('2024-03-15T09:00:00Z')
  })

  it('parses DTEND as ISO 8601', () => {
    const [event] = parseICalEvents(SIMPLE_ICS)
    expect(event.dtend).toBe('2024-03-15T09:15:00Z')
  })

  it('marks timed events as allDay=false', () => {
    const [event] = parseICalEvents(SIMPLE_ICS)
    expect(event.allDay).toBe(false)
  })
})

describe('parseICalEvents — multiple events', () => {
  it('parses all three events from multi-event feed', () => {
    const events = parseICalEvents(MULTI_EVENT_ICS)
    expect(events).toHaveLength(3)
  })

  it('each event has a unique UID', () => {
    const events = parseICalEvents(MULTI_EVENT_ICS)
    const uids = events.map(e => e.uid)
    const uniqueUids = new Set(uids)
    expect(uniqueUids.size).toBe(3)
  })

  it('extracts summaries for all events', () => {
    const events = parseICalEvents(MULTI_EVENT_ICS)
    const summaries = events.map(e => e.summary)
    expect(summaries).toContain('Planning session')
    expect(summaries).toContain('Design review')
    expect(summaries).toContain('All-hands meeting')
  })

  it('returns empty description for events without DESCRIPTION field', () => {
    const events = parseICalEvents(MULTI_EVENT_ICS)
    const planningEvent = events.find(e => e.summary === 'Planning session')!
    expect(planningEvent.description).toBe('')
  })
})

describe('parseICalEvents — all-day events', () => {
  it('marks all-day events correctly', () => {
    const [event] = parseICalEvents(ALL_DAY_ICS)
    expect(event.allDay).toBe(true)
  })

  it('parses all-day DTSTART as date string (no time component)', () => {
    const [event] = parseICalEvents(ALL_DAY_ICS)
    expect(event.dtstart).toBe('2024-04-01')
  })

  it('parses all-day DTEND as date string', () => {
    const [event] = parseICalEvents(ALL_DAY_ICS)
    expect(event.dtend).toBe('2024-04-02')
  })
})

describe('parseICalEvents — edge cases', () => {
  it('returns empty array for empty iCal text', () => {
    const events = parseICalEvents('')
    expect(events).toHaveLength(0)
  })

  it('returns empty array for VCALENDAR with no VEVENT blocks', () => {
    const ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR'
    const events = parseICalEvents(ics)
    expect(events).toHaveLength(0)
  })

  it('handles VEVENT without UID field', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:No UID event
DTSTART:20240315T090000Z
DTEND:20240315T100000Z
END:VEVENT
END:VCALENDAR`
    const events = parseICalEvents(ics)
    expect(events).toHaveLength(1)
    expect(events[0].uid).toBe('')
  })
})

// ── CalendarSyncService — sync behaviour ────────────────────────────────────

describe('CalendarSyncService — single event sync', () => {
  it('creates one capture for a single-event feed', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-cal-001' })
    const svc = makeCalendarSyncService({ insertCapture: mockInsert })
    const result = await svc.syncFeed(SIMPLE_ICS)
    expect(result.created).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('passes event data to captureInsert', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-cal-002' })
    const svc = makeCalendarSyncService({ insertCapture: mockInsert })
    await svc.syncFeed(SIMPLE_ICS)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'event-001@example.com',
        summary: 'Team standup',
      }),
      expect.any(String),
    )
  })
})

describe('CalendarSyncService — multiple events', () => {
  it('creates captures for all three events in multi-event feed', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-cal-x' })
    const svc = makeCalendarSyncService({ insertCapture: mockInsert })
    const result = await svc.syncFeed(MULTI_EVENT_ICS)
    expect(result.created).toBe(3)
    expect(mockInsert).toHaveBeenCalledTimes(3)
  })
})

// ── CalendarSyncService — dedup by UID ──────────────────────────────────────

describe('CalendarSyncService — dedup by UID', () => {
  it('skips events whose UID is already in DB', async () => {
    const existingUids = new Set(['event-dup@example.com'])
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-new' })
    const svc = makeCalendarSyncService({ existingUids, insertCapture: mockInsert })
    const result = await svc.syncFeed(DUPLICATE_ICS)
    expect(result.skipped).toBe(1)
    expect(result.created).toBe(0)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('creates only new events when feed has mix of new and existing', async () => {
    const existingUids = new Set(['event-alpha@example.com'])
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-new' })
    const svc = makeCalendarSyncService({ existingUids, insertCapture: mockInsert })
    const result = await svc.syncFeed(MULTI_EVENT_ICS)
    expect(result.created).toBe(2)
    expect(result.skipped).toBe(1)
    expect(mockInsert).toHaveBeenCalledTimes(2)
  })

  it('does not re-process the same UID on a second sync call', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-new' })
    const svc = makeCalendarSyncService({ insertCapture: mockInsert })

    // First sync — creates 1
    const first = await svc.syncFeed(SIMPLE_ICS)
    expect(first.created).toBe(1)

    // Second sync with same feed — deduped
    const second = await svc.syncFeed(SIMPLE_ICS)
    expect(second.skipped).toBe(1)
    expect(second.created).toBe(0)
  })
})

// ── CalendarSyncService — error handling ─────────────────────────────────────

describe('CalendarSyncService — error handling', () => {
  it('counts events without UID as errors', async () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:No UID
DTSTART:20240315T090000Z
DTEND:20240315T100000Z
END:VEVENT
END:VCALENDAR`
    const svc = makeCalendarSyncService({})
    const result = await svc.syncFeed(ics)
    expect(result.errors).toBe(1)
  })

  it('continues processing remaining events when one insert fails', async () => {
    let callCount = 0
    const mockInsert = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) throw new Error('DB write failed')
      return Promise.resolve({ id: `cap-${callCount}` })
    })

    const svc = makeCalendarSyncService({ insertCapture: mockInsert })
    const result = await svc.syncFeed(MULTI_EVENT_ICS)

    // First event failed, remaining two succeeded
    expect(result.errors).toBe(1)
    expect(result.created).toBe(2)
  })

  it('returns zero counts for empty iCal text', async () => {
    const svc = makeCalendarSyncService({})
    const result = await svc.syncFeed('')
    expect(result.created).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.errors).toBe(0)
  })
})

// ── CalendarSyncService — brain_view routing ─────────────────────────────────

describe('CalendarSyncService — brainView routing', () => {
  it('passes brainView=work-internal to captureInsert', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-cal' })
    const svc = makeCalendarSyncService({ insertCapture: mockInsert })
    await svc.syncFeed(SIMPLE_ICS, 'work-internal')
    expect(mockInsert).toHaveBeenCalledWith(expect.any(Object), 'work-internal')
  })

  it('defaults brainView to personal when not specified', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ id: 'cap-cal' })
    const svc = makeCalendarSyncService({ insertCapture: mockInsert })
    await svc.syncFeed(SIMPLE_ICS)
    expect(mockInsert).toHaveBeenCalledWith(expect.any(Object), 'personal')
  })
})
