import type { Database, PushoverService } from '@open-brain/shared'
import { logger, ComposioClient, SlackMessenger } from '@open-brain/shared'
import type { SlackBlock } from '@open-brain/shared'
import type { Redis } from 'ioredis'
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

export interface EmailTriageItem {
  category: string
  count: number
  topSubjects: string[]
  isPriority: boolean
}

export interface MorningBriefResult extends BaseResult {
  schedule: CalendarEvent[]
  referenceCalendar: CalendarEvent[]
  emailTriage: EmailTriageItem[]
  yesterdayThread: ThreadItem[]
  openLoops: string[]
  people: PersonItem[]
  todayItems: string[]
  notificationSent: boolean
  slackSent: boolean
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
  queryOvernightEmail,
  PRIORITY_EMAIL_CATEGORIES,
} from './morning-brief-query.js'
import type { OvernightEmailGroup } from './morning-brief-query.js'

export {
  queryYesterdayCaptures,
  queryRecentCaptures,
  queryRecentPeople,
  queryEveningCaptures,
  queryOvernightEmail,
  PRIORITY_EMAIL_CATEGORIES,
}
export type { OvernightEmailGroup }

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

/** Reference calendars — shown in a separate "view-only" section */
const REFERENCE_CALENDARS = new Set([
  'ashley davis', 'ashley\'s calendar',
  'scars',
])

/**
 * Fetch today's calendar events via Composio Outlook integration.
 * Returns primary events (Troy's calendars) and reference events
 * (Ashley's Calendar, SCARS) as separate arrays.
 * Returns empty arrays on any failure (calendar is optional enhancement).
 *
 * @param composioKey Composio API key
 * @param now Current date (overrideable for testing)
 * @param options Optional Redis + Pushover for quota metering. When provided,
 *   ComposioClient.execute() will track monthly usage and alert at thresholds.
 */
export async function fetchCalendarEvents(
  composioKey: string,
  now: Date,
  options?: { redis?: Redis; pushover?: PushoverService },
): Promise<{ primary: CalendarEvent[]; reference: CalendarEvent[] }> {
  const empty = { primary: [] as CalendarEvent[], reference: [] as CalendarEvent[] }
  if (!composioKey) return empty

  try {
    const client = new ComposioClient({
      apiKey: composioKey,
      redis: options?.redis,
      pushover: options?.pushover,
    })
    const todayStr = now.toISOString().slice(0, 10)
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toISOString().slice(0, 10)

    // List calendars first to get IDs
    const calData = await client.execute('OUTLOOK_LIST_CALENDARS', { top: '50' })
    if (!calData || !Array.isArray((calData as Record<string, unknown>).value)) return empty

    const calendars = (calData as Record<string, unknown>).value as Array<{ id: string; name: string }>
    const primary: CalendarEvent[] = []
    const reference: CalendarEvent[] = []

    for (const cal of calendars) {
      const calNameLower = cal.name.toLowerCase()
      if (SKIP_CALENDARS.has(calNameLower)) continue

      const isReference = REFERENCE_CALENDARS.has(calNameLower)

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

      const target = isReference ? reference : primary

      for (const ev of calEvents) {
        const startTime = ev.start?.dateTime
        let time = 'All day'
        if (startTime && !ev.isAllDay) {
          const d = new Date(startTime + 'Z') // Outlook returns UTC
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
        }
        target.push({
          time,
          title: ev.subject ?? '(no title)',
          calendar: cal.name,
        })
      }
    }

    // Sort by time
    const sortByTime = (a: CalendarEvent, b: CalendarEvent) => {
      if (a.time === 'All day') return -1
      if (b.time === 'All day') return 1
      return a.time.localeCompare(b.time)
    }
    primary.sort(sortByTime)
    reference.sort(sortByTime)

    logger.info(
      { primaryCount: primary.length, referenceCount: reference.length },
      '[morning-brief] calendar events fetched',
    )
    return { primary, reference }
  } catch (err) {
    logger.warn({ err }, '[morning-brief] calendar fetch failed — continuing without calendar')
    return empty
  }
}

// ============================================================
// Email triage formatting (exported for testability)
// ============================================================

/**
 * Format the OVERNIGHT EMAIL section for the morning brief.
 * Priority categories show subjects; others are aggregated into a single line.
 */
export function formatEmailTriageSection(items: EmailTriageItem[]): string {
  const lines: string[] = []
  let otherCount = 0

  for (const item of items) {
    if (item.isPriority) {
      const subjects = item.topSubjects.length > 0
        ? item.topSubjects.join(', ')
        : '(no subjects)'
      lines.push(`- ${item.category} (${item.count}): ${subjects}`)
    } else {
      otherCount += item.count
    }
  }

  if (otherCount > 0) {
    lines.push(`- ${otherCount} other email${otherCount === 1 ? '' : 's'} auto-filed`)
  }

  return `OVERNIGHT EMAIL:\n${lines.join('\n')}`
}

// ============================================================
// Reference calendar formatting (exported for testability)
// ============================================================

/** Map lowercase calendar name to display label for the brief */
const REFERENCE_CALENDAR_DISPLAY: Record<string, { label: string; icon: string }> = {
  'ashley davis': { label: "Ashley's Calendar", icon: '\uD83D\uDC41\uFE0F' },
  "ashley's calendar": { label: "Ashley's Calendar", icon: '\uD83D\uDC41\uFE0F' },
  'scars': { label: 'SCARS (Ham Radio)', icon: '\uD83D\uDCE1' },
}

/**
 * Format reference calendar events grouped by calendar name.
 * Always shows all known reference calendars — "No events today" for empty ones.
 */
export function formatReferenceCalendars(events: CalendarEvent[]): string {
  // Group events by calendar name (lowercased for matching)
  const grouped = new Map<string, CalendarEvent[]>()
  for (const ev of events) {
    const key = ev.calendar.toLowerCase()
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(ev)
  }

  // Build lines for each known reference calendar
  const lines: string[] = []

  // Deduplicate display entries — multiple keys can map to same label
  const seenLabels = new Set<string>()

  for (const [, display] of Object.entries(REFERENCE_CALENDAR_DISPLAY)) {
    if (seenLabels.has(display.label)) continue
    seenLabels.add(display.label)

    // Check all keys that map to this label
    const matchingKeys = Object.entries(REFERENCE_CALENDAR_DISPLAY)
      .filter(([, d]) => d.label === display.label)
      .map(([k]) => k)

    const calEvents: CalendarEvent[] = []
    for (const mk of matchingKeys) {
      const evts = grouped.get(mk)
      if (evts) calEvents.push(...evts)
    }

    lines.push(`${display.icon} ${display.label}`)
    if (calEvents.length === 0) {
      lines.push('- No events today')
    } else {
      for (const ev of calEvents) {
        lines.push(`- ${ev.time} ${ev.title}`)
      }
    }
  }

  return `REFERENCE CALENDARS:\n${lines.join('\n')}`
}

// ============================================================
// MorningBriefSkill
// ============================================================

/**
 * MorningBriefSkill — assembles a structured morning briefing from database
 * queries + optional Composio calendar integration. No LLM call.
 *
 * Seven sections:
 * 1. TODAY'S SCHEDULE — calendar events via Composio (if configured)
 * 2. REFERENCE CALENDARS — Ashley's Calendar, SCARS (always shown, view-only)
 * 3. OVERNIGHT EMAIL — email classifications since last brief (5 AM)
 * 4. YESTERDAY'S THREAD — captures from previous day
 * 5. OPEN LOOPS — forward-looking phrases from last 3 days
 * 6. PEOPLE — recently mentioned people with capture context
 * 7. TODAY — heuristic items from evening captures (may be empty)
 *
 * Output: Pushover notification + skills_log entry. No capture created.
 */
/** Constructor options for MorningBriefSkill. */
export interface MorningBriefSkillOpts extends BaseSkillOpts {
  composioApiKey?: string
  slackChannelId?: string
  slackBotToken?: string
  /** Optional Redis client for Composio monthly quota metering. */
  composioRedis?: Redis
  /** Optional Pushover service for Composio quota warning notifications. */
  composioPushover?: PushoverService
}

export class MorningBriefSkill extends BaseSkill<MorningBriefOptions, MorningBriefResult> {
  private composioKey: string
  private slackChannelId: string
  private slack: SlackMessenger
  private composioRedis?: Redis
  private composioPushover?: PushoverService

  constructor(opts: MorningBriefSkillOpts) {
    super('morning-brief', opts)
    this.composioKey = opts.composioApiKey ?? process.env.COMPOSIO_API_KEY ?? ''
    this.slackChannelId = opts.slackChannelId ?? process.env.MORNING_BRIEF_SLACK_CHANNEL ?? ''
    this.slack = new SlackMessenger(opts.slackBotToken)
    this.composioRedis = opts.composioRedis
    this.composioPushover = opts.composioPushover
  }

  protected async run(options: MorningBriefOptions = {}): Promise<MorningBriefResult> {
    const startMs = Date.now()
    const now = options.now ?? new Date()

    logger.info('[morning-brief] starting execution')

    // Section 0: Today's Schedule + Reference Calendars (Composio — non-blocking)
    const { primary: schedule, reference: referenceCalendar } = await fetchCalendarEvents(
      options.composioApiKey ?? this.composioKey,
      now,
      { redis: this.composioRedis, pushover: this.composioPushover },
    )

    // Section 0.5: Overnight Email (since yesterday 5 AM — when email-classify runs)
    const emailSince = new Date(now)
    emailSince.setDate(emailSince.getDate() - 1)
    emailSince.setHours(5, 0, 0, 0)
    const overnightEmailRaw = await queryOvernightEmail(this.db, emailSince)
    const emailTriage: EmailTriageItem[] = overnightEmailRaw.map(g => ({
      category: g.category,
      count: g.count,
      topSubjects: g.topSubjects,
      isPriority: PRIORITY_EMAIL_CATEGORIES.has(g.category),
    }))

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
    const message = this.formatMessage(schedule, referenceCalendar, emailTriage, yesterdayThread, openLoops, people, todayItems)
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

    // Send Slack DM (alongside Pushover, not replacing it)
    let slackSent = false
    if (message.length > 0 && this.slack.isConfigured && this.slackChannelId) {
      try {
        const blocks = this.formatSlackBlocks(title, schedule, referenceCalendar, emailTriage, yesterdayThread, openLoops, people, todayItems)
        slackSent = await this.slack.sendMessage({
          channel: this.slackChannelId,
          text: message, // plain-text fallback for notifications
          blocks,
        })
        if (slackSent) {
          logger.info('[morning-brief] Slack DM sent')
        } else {
          logger.warn('[morning-brief] Slack DM send returned false')
        }
      } catch (err) {
        logger.warn({ err }, '[morning-brief] Slack DM send failed')
      }
    } else if (message.length > 0 && !this.slack.isConfigured) {
      logger.debug('[morning-brief] Slack not configured — skipping DM')
    } else if (message.length > 0 && !this.slackChannelId) {
      logger.debug('[morning-brief] No Slack channel ID — skipping DM')
    }

    const durationMs = Date.now() - startMs

    // Log to skills_log
    const totalEmails = emailTriage.reduce((sum, e) => sum + e.count, 0)
    const result: MorningBriefResult = {
      schedule,
      referenceCalendar,
      emailTriage,
      yesterdayThread,
      openLoops,
      people,
      todayItems,
      notificationSent,
      slackSent,
      durationMs,
    }

    await this.logResult(
      result,
      `date:${now.toISOString().slice(0, 10)}`,
      [
        `schedule:${schedule.length}`,
        `refCal:${referenceCalendar.length}`,
        `email:${totalEmails}`,
        `thread:${yesterdayThread.length}`,
        `loops:${openLoops.length}`,
        `people:${people.length}`,
        `today:${todayItems.length}`,
        `pushover:${notificationSent}`,
        `slack:${slackSent}`,
      ].join(' | '),
    )

    logger.info(
      { schedule: schedule.length, refCal: referenceCalendar.length, email: totalEmails, thread: yesterdayThread.length, loops: openLoops.length, people: people.length, today: todayItems.length, notificationSent, slackSent, durationMs },
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
    referenceCalendar: CalendarEvent[],
    emailTriage: EmailTriageItem[],
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

    // Always show reference calendars (shows "No events today" for empty ones)
    sections.push(formatReferenceCalendars(referenceCalendar))

    if (emailTriage.length > 0) {
      sections.push(formatEmailTriageSection(emailTriage))
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

  // ----------------------------------------------------------
  // Private: Slack Block Kit formatting
  // ----------------------------------------------------------

  /**
   * Build Slack Block Kit blocks for a rich-formatted morning brief DM.
   * Uses header, section, and divider blocks for scannability.
   */
  formatSlackBlocks(
    title: string,
    schedule: CalendarEvent[],
    referenceCalendar: CalendarEvent[],
    emailTriage: EmailTriageItem[],
    thread: ThreadItem[],
    loops: string[],
    people: PersonItem[],
    todayItems: string[],
  ): SlackBlock[] {
    const blocks: SlackBlock[] = []

    // Header
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: title, emoji: true },
    })

    // Schedule section
    if (schedule.length > 0) {
      blocks.push({ type: 'divider' })
      const lines = schedule.map(e => `\u2022 *${e.time}* ${e.title} _[${e.calendar}]_`)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*:calendar: Today's Schedule*\n${lines.join('\n')}` },
      })
    }

    // Reference calendars section (always shown)
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*:eyes: Reference Calendars*\n${formatReferenceCalendars(referenceCalendar).replace('REFERENCE CALENDARS:\n', '')}` },
    })

    // Email triage section
    if (emailTriage.length > 0) {
      blocks.push({ type: 'divider' })
      const lines: string[] = []
      let otherCount = 0
      for (const item of emailTriage) {
        if (item.isPriority) {
          const subjects = item.topSubjects.length > 0
            ? item.topSubjects.join(', ')
            : '(no subjects)'
          lines.push(`\u2022 *${item.category}* (${item.count}): ${subjects}`)
        } else {
          otherCount += item.count
        }
      }
      if (otherCount > 0) {
        lines.push(`\u2022 ${otherCount} other email${otherCount === 1 ? '' : 's'} auto-filed`)
      }
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*:email: Overnight Email*\n${lines.join('\n')}` },
      })
    }

    // Yesterday's thread section
    if (thread.length > 0) {
      blocks.push({ type: 'divider' })
      const lines = thread.map(t => `\u2022 ${t.snippet}`)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*:thread: Yesterday's Thread*\n${lines.join('\n')}` },
      })
    }

    // Open loops section
    if (loops.length > 0) {
      blocks.push({ type: 'divider' })
      const lines = loops.map(l => `\u2022 ${l}`)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*:arrows_counterclockwise: Open Loops*\n${lines.join('\n')}` },
      })
    }

    // People section
    if (people.length > 0) {
      blocks.push({ type: 'divider' })
      const lines = people.map(p => `\u2022 *${p.name}* \u2014 ${truncateToSnippet(p.snippet, 60)}`)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*:busts_in_silhouette: People*\n${lines.join('\n')}` },
      })
    }

    // Today items section
    if (todayItems.length > 0) {
      blocks.push({ type: 'divider' })
      const lines = todayItems.map(t => `\u2022 ${t}`)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*:pushpin: Today*\n${lines.join('\n')}` },
      })
    }

    return blocks
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
