/**
 * Slack message formatters for Open Brain bot responses.
 * Uses Slack mrkdwn formatting (bold: *, italic: _, code: `, etc.)
 */

import type { SearchResult, CaptureResult, BrainStats, TriggerRecord, TriggerMatch, EntityRecord, SessionRecord, BetRecord, PipelineStatus, RecentCapture } from './core-api-client.js'

// Date formatting helper
function formatDate(isoDate: string): string {
  const date = new Date(isoDate)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// Truncate content with ellipsis
function truncate(text: string, maxLen = 150): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

/**
 * Format search results for Slack display.
 * Supports pagination via page and pageSize parameters.
 */
export function formatSearchResults(
  results: SearchResult[],
  query: string,
  page = 1,
  pageSize = 5,
): string {
  if (results.length === 0) {
    return `:mag: No results found for "${query}"`
  }

  const startIdx = (page - 1) * pageSize
  const endIdx = Math.min(startIdx + pageSize, results.length)
  const pageResults = results.slice(startIdx, endIdx)
  const hasMore = endIdx < results.length

  const header = `:mag: *Results for "${query}"* (${results.length} total)\n\n`

  const lines = pageResults.map((r, i) => {
    const num = startIdx + i + 1
    const pct = `${Math.round(r.score * 100)}%`
    const date = formatDate(r.created_at)
    const topics = r.pre_extracted?.topics?.slice(0, 3).join(', ') || ''
    const content = truncate(r.content)

    let line = `*${num}.* [${r.capture_type}] ${date} — ${pct} match\n`
    line += `> ${content}`
    if (topics) {
      line += `\n_Topics: ${topics}_`
    }
    return line
  })

  let footer = ''
  if (hasMore) {
    footer = `\n\n_Say "more" for next page, or reply with a number (1-${results.length}) to see details._`
  } else {
    footer = `\n\n_Reply with a number (1-${results.length}) to see the full capture._`
  }

  return header + lines.join('\n\n') + footer
}

/**
 * Format a single capture for detailed display.
 */
export function formatCapture(capture: CaptureResult): string {
  const date = formatDate(capture.created_at)
  const people = capture.pre_extracted?.entities
    ?.filter(e => e.type === 'person')
    .map(e => e.name)
    .join(', ') || 'none'
  const topics = capture.pre_extracted?.topics?.join(', ') || 'none'
  const sentiment = capture.pre_extracted?.sentiment || 'n/a'

  return `*Capture Details*

*ID:* \`${capture.id}\`
*Type:* ${capture.capture_type}
*View:* ${capture.brain_view}
*Source:* ${capture.source}
*Status:* ${capture.pipeline_status}
*Captured:* ${date}

*Content:*
> ${capture.content}

*People:* ${people}
*Topics:* ${topics}
*Sentiment:* ${sentiment}`
}

/**
 * Format brain stats summary.
 */
export function formatStats(stats: BrainStats): string {
  const byTypeEntries = Object.entries(stats.by_type).sort((a, b) => b[1] - a[1])
  const byTypeStr = byTypeEntries.length > 0
    ? byTypeEntries.map(([k, v]) => `${k}: ${v}`).join(', ')
    : '(none)'

  const bySourceEntries = Object.entries(stats.by_source).sort((a, b) => b[1] - a[1])
  const bySourceStr = bySourceEntries.length > 0
    ? bySourceEntries.map(([k, v]) => `${k}: ${v}`).join(', ')
    : '(none)'

  const ph = stats.pipeline_health

  return `:brain: *Brain Stats* — ${stats.total_captures} total captures

*By Type:* ${byTypeStr}
*By Source:* ${bySourceStr}

*Pipeline Health:*
• pending: ${ph.pending}
• processing: ${ph.processing}
• complete: ${ph.complete}
• failed: ${ph.failed}`
}

/**
 * Format error messages for Slack.
 */
export function formatError(context: string, error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : error === null || error === undefined
      ? 'Unknown error'
      : String(error)

  return `:warning: *${context}*: ${message}`
}

/**
 * Format capture confirmation after successful creation.
 */
export function formatCaptureConfirmation(capture: CaptureResult): string {
  return `:white_check_mark: Captured as *${capture.capture_type}* in _${capture.brain_view}_ (ID: \`${capture.id.slice(0, 8)}...\`)`
}

/**
 * Format trigger list.
 */
export function formatTriggerList(triggers: TriggerRecord[]): string {
  if (triggers.length === 0) {
    return ':zap: No triggers configured'
  }

  const header = `:zap: *Active Triggers* (${triggers.length})\n\n`
  const lines = triggers.map((t, i) => {
    const status = t.enabled ? ':green_circle:' : ':red_circle:'
    return `${i + 1}. ${status} *${t.name}* — ${t.description || '(no description)'}`
  })

  return header + lines.join('\n')
}

/**
 * Format trigger test results.
 */
export function formatTriggerTestResults(matches: TriggerMatch[]): string {
  if (matches.length === 0) {
    return ':zap: No triggers matched this capture'
  }

  const header = `:zap: *Trigger Test Results*\n\n`
  const lines = matches.map(m => {
    const icon = m.matched ? ':white_check_mark:' : ':x:'
    const pct = `${Math.round(m.confidence * 100)}%`
    return `${icon} *${m.trigger_name}* — ${pct} confidence`
  })

  return header + lines.join('\n')
}

/**
 * Format entity list.
 */
export function formatEntityList(entities: EntityRecord[], total: number): string {
  if (entities.length === 0) {
    return ':busts_in_silhouette: No entities found'
  }

  const header = `:busts_in_silhouette: *Entities* (${total} total)\n\n`
  const lines = entities.map((e, i) => {
    const aliases = e.aliases.length > 0 ? ` (aka: ${e.aliases.slice(0, 2).join(', ')})` : ''
    return `${i + 1}. *${e.name}*${aliases} — ${e.capture_count} captures`
  })

  return header + lines.join('\n')
}

/**
 * Format entity details.
 */
export function formatEntityDetails(entity: EntityRecord & { captures: CaptureResult[] }): string {
  const header = `:bust_in_silhouette: *${entity.name}* (${entity.type})\n`
  const aliases = entity.aliases.length > 0
    ? `_Also known as: ${entity.aliases.join(', ')}_\n`
    : ''

  const captureList = entity.captures.slice(0, 5).map(c => {
    const date = formatDate(c.created_at)
    return `• [${c.capture_type}] ${truncate(c.content, 80)} — ${date}`
  }).join('\n')

  return `${header}${aliases}\n*Recent Captures:*\n${captureList || '(none)'}`
}

/**
 * Format session info.
 */
export function formatSessionInfo(session: SessionRecord): string {
  const messageCount = session.messages.length
  const lastMsg = session.messages[session.messages.length - 1]
  const preview = lastMsg ? truncate(lastMsg.content, 100) : '(no messages)'

  return `:speech_balloon: *Session ${session.id.slice(0, 8)}...* (${session.type})
*Status:* ${session.status}
*View:* ${session.brain_view}
*Messages:* ${messageCount}
*Last:* ${preview}`
}

/**
 * Format session response (assistant message).
 */
export function formatSessionResponse(session: SessionRecord): string {
  const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant')
  return lastAssistant?.content || '(no response)'
}

/**
 * Format bet list.
 */
export function formatBetList(bets: BetRecord[]): string {
  if (bets.length === 0) {
    return ':dart: No active bets'
  }

  const header = `:dart: *Active Bets*\n\n`
  const lines = bets.map((b, i) => {
    const due = formatDate(b.due_date)
    const status = b.status === 'open' ? ':hourglass:' : b.status === 'won' ? ':trophy:' : ':x:'
    return `${i + 1}. ${status} *${truncate(b.description, 60)}*\n   Due: ${due} | View: ${b.brain_view}`
  })

  return header + lines.join('\n')
}

/**
 * Format bet details.
 */
export function formatBetDetails(bet: BetRecord): string {
  const due = formatDate(bet.due_date)
  const created = formatDate(bet.created_at)
  const statusIcon = bet.status === 'open' ? ':hourglass:' : bet.status === 'won' ? ':trophy:' : ':x:'

  return `${statusIcon} *Bet Details*

*Description:* ${bet.description}
*Due:* ${due}
*View:* ${bet.brain_view}
*Status:* ${bet.status}
*Created:* ${created}
${bet.outcome ? `*Outcome:* ${bet.outcome}` : ''}`
}

/**
 * Format pipeline status.
 */
export function formatPipelineStatus(status: PipelineStatus): string {
  const q = status.queue_depth
  const failedList = status.failed_jobs.slice(0, 3).map(j =>
    `• \`${j.id.slice(0, 8)}...\` — ${j.failed_reason}`
  ).join('\n')

  return `:gear: *Pipeline Status*

*Queue Depth:*
• pending: ${q.pending}
• active: ${q.active}
• completed: ${q.completed}
• failed: ${q.failed}
• delayed: ${q.delayed}

*Stale Captures:* ${status.stale_count}

*Recent Failures:*
${failedList || '(none)'}`
}

/**
 * Format recent captures list.
 */
export function formatRecentCaptures(captures: RecentCapture[]): string {
  if (captures.length === 0) {
    return ':inbox_tray: No recent captures'
  }

  const header = `:inbox_tray: *Recent Captures*\n\n`
  const lines = captures.map((c, i) => {
    const date = formatDate(c.created_at)
    return `${i + 1}. [${c.capture_type}] ${truncate(c.content, 80)} — ${date}`
  })

  return header + lines.join('\n')
}

// Alias for backwards compatibility
export const formatEntityDetail = formatEntityDetails

/**
 * Format entity merge result.
 */
export function formatEntityMerge(result: { merged_entity_id: string; merged_count: number }): string {
  return `:link: *Entities Merged*\nNew entity ID: \`${result.merged_entity_id}\`\nMerged ${result.merged_count} entities`
}

/**
 * Format entity split result.
 */
export function formatEntitySplit(result: { new_entities: string[] }): string {
  const list = result.new_entities.map(id => `• \`${id}\``).join('\n')
  return `:scissors: *Entity Split*\nCreated ${result.new_entities.length} new entities:\n${list}`
}

/**
 * Format session pause message.
 */
export function formatSessionPause(session: SessionRecord): string {
  return `:pause_button: Session \`${session.id.slice(0, 8)}...\` paused. Say "continue" to resume.`
}

/**
 * Format session completion message.
 */
export function formatSessionComplete(session: SessionRecord): string {
  const messageCount = session.messages.length
  return `:white_check_mark: Session \`${session.id.slice(0, 8)}...\` completed with ${messageCount} messages.`
}

/**
 * Format session list.
 */
export function formatSessionList(sessions: SessionRecord[]): string {
  if (sessions.length === 0) {
    return ':speech_balloon: No active sessions'
  }

  const header = `:speech_balloon: *Sessions*\n\n`
  const lines = sessions.map((s, i) => {
    const status = s.status === 'active' ? ':green_circle:' : ':white_circle:'
    return `${i + 1}. ${status} *${s.type}* (${s.brain_view}) — ${s.messages.length} messages`
  })

  return header + lines.join('\n')
}

/**
 * Format session start message.
 */
export function formatSessionStart(session: SessionRecord): string {
  const firstAssistant = session.messages.find(m => m.role === 'assistant')
  const intro = firstAssistant?.content || 'Session started.'
  return `:speech_balloon: *${session.type} session started* (${session.brain_view})\n\n${intro}`
}

/**
 * Format bet creation confirmation.
 */
export function formatBetCreate(bet: BetRecord): string {
  const due = formatDate(bet.due_date)
  return `:dart: *Bet Created*\n${bet.description}\n_Due: ${due} | View: ${bet.brain_view}_`
}

/**
 * Format expiring bets warning.
 */
export function formatBetsExpiring(bets: BetRecord[]): string {
  if (bets.length === 0) {
    return ':dart: No bets expiring soon'
  }

  const header = `:warning: *Bets Expiring Soon*\n\n`
  const lines = bets.map((b, i) => {
    const due = formatDate(b.due_date)
    return `${i + 1}. *${truncate(b.description, 60)}* — Due: ${due}`
  })

  return header + lines.join('\n')
}

/**
 * Format bet resolution confirmation.
 */
export function formatBetResolve(bet: BetRecord): string {
  const icon = bet.outcome === 'won' ? ':trophy:' : ':x:'
  return `${icon} *Bet Resolved*\n${bet.description}\n_Outcome: ${bet.outcome}_`
}
