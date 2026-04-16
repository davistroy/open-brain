import type { Database } from '@open-brain/shared'
import { logger, ComposioClient } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'

// ============================================================
// Types
// ============================================================

export interface MorningBriefOptions {
  /** Override "now" for deterministic testing */
  now?: Date
  /** Composio API key for calendar integration (optional) */
  composioApiKey?: string
}

export interface CalendarEvent {
  time: string
  title: string
  calendar: string
}

export interface MorningBriefResult extends BaseResult {
  schedule: CalendarEvent[]
  yesterdayThread: ThreadItem[]
  openLoops: string[]
  people: PersonItem[]
  todayItems: string[]
  notificationSent: boolean
}

export interface ThreadItem {
  id: string
  snippet: string
}

export interface PersonItem {
  name: string
  snippet: string
}

// ============================================================
// Forward-looking phrase patterns
// ============================================================

const OPEN_LOOP_PATTERNS = [
  'need to',
  'waiting on',
  'follow up',
  'approval',
  'should',
  'tomorrow',
  'next step',
]

// ============================================================
// Query helpers — imported from morning-brief-query.ts and re-exported for backward compat
// ============================================================

import {
  queryYesterdayCaptures,
  queryRecentCaptures,
  queryRecentPeople,
  queryEveningCaptures,
} from './morning-brief-query.js'

export {
  queryYesterdayCaptures,
  queryRecentCaptures,
  queryRecentPeople,
  queryEveningCaptures,
}

// ============================================================
// Text extraction helpers (exported for testability)
// ============================================================

/**
 * Truncate content to first sentence or maxLen chars, whichever is shorter.
 */
export function truncateToSnippet(content: string, maxLen = 100): string {
  const trimmed = content.trim()
  // Find first sentence boundary
  const sentenceEnd = trimmed.search(/[.!?]\s/)
  if (sentenceEnd > 0 && sentenceEnd < maxLen) {
    return trimmed.slice(0, sentenceEnd + 1)
  }
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen) + '...'
}

/**
 * Extract sentences containing forward-looking phrases from capture content.
 * Returns unique matching sentences.
 */
export function extractOpenLoops(captures: Array<{ content: string }>): string[] {
  const seen = new Set<string>()
  const results: string[] = []

  for (const cap of captures) {
    // Split on sentence boundaries: period+space, newline, or end of string
    const sentences = cap.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 10) // Skip very short fragments

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()
      const hasPattern = OPEN_LOOP_PATTERNS.some(p => lower.includes(p))
      if (hasPattern && !seen.has(lower)) {
        seen.add(lower)
        results.push(truncateToSnippet(sentence, 120))
        if (results.length >= 5) return results
      }
    }
  }

  return results
}

/**
 * Extract today-relevant items from evening captures.
 * Looks for today's day name or "tomorrow" + activity context.
 */
export function extractTodayItems(
  captures: Array<{ content: string }>,
  now: Date,
): string[] {
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const todayName = dayNames[now.getDay()]
  const results: string[] = []
  const seen = new Set<string>()

  for (const cap of captures) {
    const sentences = cap.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 10)

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()
      const mentionsToday = lower.includes(todayName) || lower.includes('tomorrow')
      if (mentionsToday && !seen.has(lower)) {
        seen.add(lower)
        results.push(truncateToSnippet(sentence, 120))
        if (results.length >= 5) return results
      }
    }
  }

  return results
}

// ============================================================
// Calendar helpers (Composio)
// ============================================================

/** Calendar names to skip (not useful in brief) */
const SKIP_CALENDARS = new Set([
  'birthdays', 'licw', 'your family', 'troy davis',
  'jamie davis', 'daniel davis',
])

/**
 * Fetch today's calendar events via Composio Outlook integration.
 * Returns empty array on any failure (calendar is optional enhancement).
 */
export async function fetchCalendarEvents(
  composioKey: string,
  now: Date,
): Promise<CalendarEvent[]> {
  if (!composioKey) return []

  try {
    const client = new ComposioClient(composioKey)
    const todayStr = now.toISOString().slice(0, 10)
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().slice(0, 10)

    // List calendars first to get IDs
    const calData = await client.execute('OUTLOOK_LIST_CALENDARS', { top: '50' })
    if (!calData || !Array.isArray((calData as Record<string, unknown>).value)) return []

    const calendars = (calData as Record<string, unknown>).value as Array<{ id: string; name: string }>
    const events: CalendarEvent[] = []

    for (const cal of calendars) {
      if (SKIP_CALENDARS.has(cal.name.toLowerCase())) continue

      const evData = await client.execute('OUTLOOK_GET_CALENDAR_VIEW', {
        calendar_id: cal.id,
        start_date_time: `${todayStr}T00:00:00`,
        end_date_time: `${tomorrowStr}T00:00:00`,
        top: '20',
      })

      if (!evData || !Array.isArray((evData as Record<string, unknown>).value)) continue

      const calEvents = (evData as Record<string, unknown>).value as Array<{
        subject?: string
        start?: { dateTime?: string }
        isAllDay?: boolean
      }>

      for (const ev of calEvents) {
        const startTime = ev.start?.dateTime
        let time = 'All day'
        if (startTime && !ev.isAllDay) {
          const d = new Date(startTime + 'Z') // Outlook returns UTC
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
        }
        events.push({
          time,
          title: ev.subject ?? '(no title)',
          calendar: cal.name,
        })
      }
    }

    // Sort by time
    events.sort((a, b) => {
      if (a.time === 'All day') return -1
      if (b.time === 'All day') return 1
      return a.time.localeCompare(b.time)
    })

    logger.info({ eventCount: events.length }, '[morning-brief] calendar events fetched')
    return events
  } catch (err) {
    logger.warn({ err }, '[morning-brief] calendar fetch failed — continuing without calendar')
    return []
  }
}

// ============================================================
// MorningBriefSkill
// ============================================================

/**
 * MorningBriefSkill — assembles a structured morning briefing from database
 * queries + optional Composio calendar integration. No LLM call.
 *
 * Five sections:
 * 1. TODAY'S SCHEDULE — calendar events via Composio (if configured)
 * 2. YESTERDAY'S THREAD — captures from previous day
 * 3. OPEN LOOPS — forward-looking phrases from last 3 days
 * 4. PEOPLE — recently mentioned people with capture context
 * 5. TODAY — heuristic items from evening captures (may be empty)
 *
 * Output: Pushover notification + skills_log entry. No capture created.
 */
/** Constructor options for MorningBriefSkill. */
export interface MorningBriefSkillOpts extends BaseSkillOpts {
  composioApiKey?: string
}

export class MorningBriefSkill extends BaseSkill<MorningBriefOptions, MorningBriefResult> {
  private composioKey: string

  constructor(opts: MorningBriefSkillOpts) {
    super('morning-brief', opts)
    this.composioKey = opts.composioApiKey ?? process.env.COMPOSIO_API_KEY ?? ''
  }

  async execute(options: MorningBriefOptions = {}): Promise<MorningBriefResult> {
    const startMs = Date.now()
    const now = options.now ?? new Date()

    logger.info('[morning-brief] starting execution')

    // Section 0: Today's Schedule (Composio calendar — non-blocking)
    const schedule = await fetchCalendarEvents(options.composioApiKey ?? this.composioKey, now)

    // Section 1: Yesterday's Thread
    const yesterdayCaptures = await queryYesterdayCaptures(this.db, now)
    const yesterdayThread: ThreadItem[] = yesterdayCaptures.map(c => ({
      id: c.id,
      snippet: truncateToSnippet(c.content),
    }))

    // Section 2: Open Loops
    const recentCaptures = await queryRecentCaptures(this.db, now)
    const openLoops = extractOpenLoops(recentCaptures)

    // Section 3: People
    const people = await queryRecentPeople(this.db, now)

    // Section 4: Today's Items
    const eveningCaptures = await queryEveningCaptures(this.db, now)
    const todayItems = extractTodayItems(eveningCaptures, now)

    // Format notification message
    const message = this.formatMessage(schedule, yesterdayThread, openLoops, people, todayItems)
    const title = this.formatTitle(now)

    // Send Pushover notification
    let notificationSent = false
    if (message.length > 0 && this.pushover.isConfigured) {
      try {
        await this.pushover.send({
          title,
          message,
          priority: 0,
        })
        notificationSent = true
        logger.info('[morning-brief] Pushover notification sent')
      } catch (err) {
        logger.warn({ err }, '[morning-brief] Pushover send failed')
      }
    } else if (message.length === 0) {
      logger.info('[morning-brief] all sections empty — skipping notification')
    } else {
      logger.debug('[morning-brief] Pushover not configured — skipping')
    }

    const durationMs = Date.now() - startMs

    // Log to skills_log
    const result: MorningBriefResult = {
      schedule,
      yesterdayThread,
      openLoops,
      people,
      todayItems,
      notificationSent,
      durationMs,
    }

    await this.logResult(
      result,
      `date:${now.toISOString().slice(0, 10)}`,
      [
        `schedule:${schedule.length}`,
        `thread:${yesterdayThread.length}`,
        `loops:${openLoops.length}`,
        `people:${people.length}`,
        `today:${todayItems.length}`,
        `sent:${notificationSent}`,
      ].join(' | '),
    )

    logger.info(
      { schedule: schedule.length, thread: yesterdayThread.length, loops: openLoops.length, people: people.length, today: todayItems.length, notificationSent, durationMs },
      '[morning-brief] execution complete',
    )

    return result
  }

  // ----------------------------------------------------------
  // Private: message formatting
  // ----------------------------------------------------------

  private formatTitle(now: Date): string {
    const month = now.toLocaleString('en-US', { month: 'long' })
    const day = now.getDate()
    return `Morning Brief \u2014 ${month} ${day}`
  }

  private formatMessage(
    schedule: CalendarEvent[],
    thread: ThreadItem[],
    loops: string[],
    people: PersonItem[],
    todayItems: string[],
  ): string {
    const sections: string[] = []

    if (schedule.length > 0) {
      const lines = schedule.map(e => `- ${e.time} ${e.title} [${e.calendar}]`)
      sections.push(`TODAY'S SCHEDULE:\n${lines.join('\n')}`)
    }

    if (thread.length > 0) {
      const lines = thread.map(t => `- ${t.snippet}`)
      sections.push(`YESTERDAY'S THREAD:\n${lines.join('\n')}`)
    }

    if (loops.length > 0) {
      const lines = loops.map(l => `- ${l}`)
      sections.push(`OPEN LOOPS:\n${lines.join('\n')}`)
    }

    if (people.length > 0) {
      const lines = people.map(p => `- ${p.name} (${truncateToSnippet(p.snippet, 40)})`)
      sections.push(`PEOPLE:\n${lines.join('\n')}`)
    }

    if (todayItems.length > 0) {
      const lines = todayItems.map(t => `- ${t}`)
      sections.push(`TODAY:\n${lines.join('\n')}`)
    }

    return sections.join('\n\n')
  }
}

// ============================================================
// Skill execution entry point — called by BullMQ skill worker
// ============================================================

/**
 * Top-level function invoked by the skill-execution BullMQ worker.
 *
 * Constructs MorningBriefSkill with production dependencies and executes.
 */
export async function executeMorningBrief(
  db: Database,
  options: MorningBriefOptions = {},
): Promise<MorningBriefResult> {
  const skill = new MorningBriefSkill({ db })
  return skill.execute(options)
}
