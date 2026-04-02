/**
 * Format attributed responses for auto-response feature.
 * Produces Slack mrkdwn with source citations.
 */

import type { SearchResult } from '../lib/core-api-types.js'

export interface AttributedResponse {
  /** Full Slack mrkdwn message text */
  text: string
  /** Short summary for Pushover notifications */
  summary: string
  /** Source citations */
  sources: Array<{ id: string; date: string; source: string; excerpt: string }>
}

/**
 * Format a synthesis response with attribution for Slack posting.
 */
export function formatAttributedResponse(
  synthesis: string,
  results: SearchResult[],
  opts?: { maxSources?: number },
): AttributedResponse {
  const maxSources = opts?.maxSources ?? 3

  // Build source citations
  const sources = results.slice(0, maxSources).map(r => {
    const date = new Date(r.created_at).toISOString().split('T')[0]
    const source = r.source ?? 'unknown'
    const excerpt = r.content.length > 80 ? r.content.slice(0, 80) + '...' : r.content
    return { id: r.id, date, source, excerpt }
  })

  // Build Slack mrkdwn
  const citationLines = sources
    .map((s, i) => `> _[${i + 1}] ${s.date} (${s.source}): ${s.excerpt}_`)
    .join('\n')

  const text = [
    'Based on captured context:\n',
    synthesis,
    '\n---\n_Sources:_',
    citationLines,
    '\n_This is an AI-generated response based on captured context._',
  ].join('\n')

  // Short summary for Pushover
  const summary = synthesis.length > 200 ? synthesis.slice(0, 200) + '...' : synthesis

  return { text, summary, sources }
}
