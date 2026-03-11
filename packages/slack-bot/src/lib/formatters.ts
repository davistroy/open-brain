/**
 * Slack message formatters for Open Brain bot responses.
 * Uses Slack mrkdwn formatting (bold: *, italic: _, code: `, etc.)
 */

import type { SearchResult, CaptureResult, BrainStats, TriggerRecord, TriggerMatch, EntityRecord, SessionRecord, BetRecord, PipelineStatus, RecentCapture } from './core-api-client.js'

// Date formatting helper
function formatDate(isoDate: string): string {
  const date = new Date(isoDate.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
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
    const content = truncate(r.content ?? '')

    let line = `${num}. *[${r.capture_type}]* ${date} — ${pct} match\n`
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
    const status = t.is_active ? ':green_circle:' : ':red_circle:'
    return `${i + 1}. ${status} *${t.name}* — threshold: ${t.threshold}`
  })

  return header + lines.join('\n')
}

/**
 * Format trigger test results.
 * @param queryText - the query that was tested
 * @param matches - capture matches returned by the API
 */
export function formatTriggerTestResults(queryText: string, matches: TriggerMatch[]): string {
  if (matches.length === 0) {
    return `:zap: *Trigger Test* — \`${queryText}\`\n\nNo matches found (no notification fired)`
  }

  const header = `:zap: *Trigger Test* — \`${queryText}\` (${matches.length} match${matches.length === 1 ? '' : 'es'}, no notification fired)\n\n`
  const lines = matches.map((m, i) => {
    const pct = `${Math.round(m.similarity * 100)}%`
    const date = formatDate(m.created_at)
    return `${i + 1}. *[${m.capture_type}]* ${date} — ${pct}\n> ${truncate(m.content, 120)}`
  })

  return header + lines.join('\n\n')
}

/**
 * Format entity list.
 */
export function formatEntityList(entities: EntityRecord[], total?: number): string {
  if (entities.length === 0) {
    return ':busts_in_silhouette: No entities found'
  }

  const displayTotal = total ?? entities.length
  const header = `:busts_in_silhouette: *Entities* (${displayTotal} total)\n\n`
  const lines = entities.map((e, i) => {
    const aliases = e.aliases.length > 0 ? ` (aka: ${e.aliases.slice(0, 2).join(', ')})` : ''
    return `${i + 1}. *${e.name}*${aliases} — ${e.capture_count} captures`
  })

  return header + lines.join('\n')
}

/**
 * Format entity details.
 */
export function formatEntityDetails(entity: EntityRecord & { captures?: CaptureResult[] }): string {
  const header = `:bust_in_silhouette: *${entity.name}* (${entity.type})\n`
  const aliases = entity.aliases.length > 0
    ? `_Also known as: ${entity.aliases.join(', ')}_\n`
    : ''

  const captureList = (entity.captures ?? []).slice(0, 5).map(c => {
    const date = formatDate(c.created_at)
    return `• [${c.capture_type}] ${truncate(c.content ?? '', 80)} — ${date}`
  }).join('\n')

  return `${header}${aliases}\n*Recent Captures:*\n${captureList || '(none)'}`
}

/**
 * Format session info.
 */
export function formatSessionInfo(session: SessionRecord): string {
  return `:speech_balloon: *Session ${session.id.slice(0, 8)}...* (${session.session_type})
*Status:* ${session.status}
*Created:* ${formatDate(session.created_at)}`
}

/**
 * Format session response (assistant message).
 * @deprecated Use the bot_message string directly from sessions_respond result.
 */
export function formatSessionResponse(botMessage: string): string {
  return botMessage || '(no response)'
}

/**
 * Format bet list.
 */
export function formatBetList(bets: BetRecord[], _statusFilter?: string): string {
  if (bets.length === 0) {
    return ':dart: No bets found'
  }

  const header = `:dart: *Bets* (${bets.length})\n\n`
  const lines = bets.map((b, i) => {
    const due = b.resolution_date ? formatDate(b.resolution_date) : '—'
    const icon = b.resolution ? (b.resolution === 'correct' ? ':trophy:' : ':x:') : ':hourglass:'
    const conf = `${Math.round(b.confidence * 100)}%`
    return `${i + 1}. ${icon} *${truncate(b.statement, 60)}*\n   Confidence: ${conf} | Due: ${due}`
  })

  return header + lines.join('\n')
}

/**
 * Format bet details.
 */
export function formatBetDetails(bet: BetRecord): string {
  const due = bet.resolution_date ? formatDate(bet.resolution_date) : '—'
  const created = formatDate(bet.created_at)
  const icon = bet.resolution ? (bet.resolution === 'correct' ? ':trophy:' : ':x:') : ':hourglass:'

  return `${icon} *Bet Details*

*Statement:* ${bet.statement}
*Confidence:* ${Math.round(bet.confidence * 100)}%
*Due:* ${due}
*Created:* ${created}
${bet.resolution ? `*Resolution:* ${bet.resolution}` : ''}
${bet.resolution_notes ? `*Notes:* ${bet.resolution_notes}` : ''}`
}

/**
 * Format pipeline status.
 */
export function formatPipelineStatus(status: PipelineStatus): string {
  const queueLines = Object.entries(status.queues).map(([name, q]) =>
    `• *${name}*: waiting ${q.waiting} | active ${q.active} | failed ${q.failed}`
  ).join('\n')

  const o = status.overall
  return `:gear: *Pipeline Status*

*Queues:*
${queueLines || '(none)'}

*Overall:*
• pending: ${o.pending} | processing: ${o.processing} | complete: ${o.complete} | failed: ${o.failed}`
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
    return `${i + 1}. [${c.capture_type}] ${truncate(c.content ?? '', 80)} — ${date}`
  })

  return header + lines.join('\n')
}

// Alias for backwards compatibility
export const formatEntityDetail = formatEntityDetails

/**
 * Format entity merge result.
 */
export function formatEntityMerge(result: { message: string; source_id: string; target_id: string }): string {
  return `:link: *Merge Complete*\n${result.message}\nSource: \`${result.source_id.slice(0, 8)}...\` → Target: \`${result.target_id.slice(0, 8)}...\``
}

/**
 * Format entity split result.
 */
export function formatEntitySplit(result: { message: string; source_entity_id: string; new_entity_id: string; alias: string }): string {
  return `:scissors: *Split Complete*\n${result.message}\nNew entity: \`${result.new_entity_id}\``
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
  return `:white_check_mark: Session \`${session.id.slice(0, 8)}...\` completed.`
}

/**
 * Format session list.
 */
export function formatSessionList(sessions: SessionRecord[]): string {
  if (sessions.length === 0) {
    return ':speech_balloon: No active governance sessions'
  }

  const header = `:speech_balloon: *Governance Sessions* (${sessions.length})\n\n`
  const lines = sessions.map((s, i) => {
    const status = s.status === 'active' ? ':green_circle:' : ':white_circle:'
    return `${i + 1}. ${status} *${s.session_type}* — ${s.status} | \`${s.id.slice(0, 8)}...\``
  })

  return header + lines.join('\n')
}

/**
 * Format session start message.
 * @param sessionId - the new session's ID
 * @param sessionType - human-readable session type (e.g. "quick board check")
 * @param firstMessage - the bot's opening message
 */
export function formatSessionStart(sessionId: string, sessionType: string, firstMessage: string): string {
  return `:speech_balloon: *Starting ${sessionType}* (\`${sessionId.slice(0, 8)}...\`)\n\n*Board:* ${firstMessage}`
}

/**
 * Format bet creation confirmation.
 */
export function formatBetCreate(bet: BetRecord): string {
  const due = bet.resolution_date ? formatDate(bet.resolution_date) : '—'
  const conf = `${Math.round(bet.confidence * 100)}%`
  return `:dart: *Bet recorded* (${conf} confidence)\n${bet.statement}\n_Due: ${due}_`
}

/**
 * Format expiring bets warning.
 */
export function formatBetsExpiring(bets: BetRecord[], daysAhead?: number): string {
  if (bets.length === 0) {
    return ':dart: No bets expiring soon'
  }

  const header = `:warning: *Bets Expiring${daysAhead ? ` in ${daysAhead} days` : ' Soon'}*\n\n`
  const lines = bets.map((b, i) => {
    const due = b.resolution_date ? formatDate(b.resolution_date) : '—'
    return `${i + 1}. *${truncate(b.statement, 60)}* — Due: ${due}`
  })

  return header + lines.join('\n')
}

/**
 * Format bet resolution confirmation.
 */
export function formatBetResolve(bet: BetRecord): string {
  const icon = bet.resolution === 'correct' ? ':trophy:' : ':x:'
  return `${icon} *Bet resolved*\n${bet.statement}\n_Resolution: ${bet.resolution}_`
}
