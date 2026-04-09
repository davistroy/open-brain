import { z } from 'zod'
import type { SearchService } from '../../services/search.js'
import type { SearchResult } from '../../services/search.js'

export const searchBrainSchema = z.object({
  query: z.string().min(1).describe('Search query string'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of results to return'),
  threshold: z.number().min(0).max(1).default(0.0).describe('Minimum relevance score threshold (0–1)'),
  source_filter: z.string().optional().describe('Filter by source (e.g. slack, api, voice)'),
  tag_filter: z.array(z.string()).optional().describe('Filter by tags'),
  brain_view: z.string().optional().describe('Filter by brain view (career, personal, technical, work-internal, client)'),
  days: z.number().int().min(1).optional().describe('Limit results to the last N days'),
  include_related: z.boolean().default(true).describe('Include related captures found via entity graph traversal (spreading activation). Default true — AI agents benefit from broader context. Set false to get only direct search results.'),
})

export type SearchBrainInput = z.infer<typeof searchBrainSchema>

/** Format a single search result as text lines */
function formatResult(index: number, { capture, score }: SearchResult): string[] {
  const date = new Date(capture.captured_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  const matchPct = Math.round(score * 100)
  const preview = capture.content.length > 500
    ? capture.content.slice(0, 500).trimEnd() + '…'
    : capture.content

  const lines: string[] = []
  lines.push(`${index}. [${matchPct}% match] ${capture.capture_type.toUpperCase()} — ${date} (${capture.source})`)
  lines.push(`   ID: ${capture.id}`)
  if (capture.brain_view) lines.push(`   View: ${capture.brain_view}`)
  if (capture.tags && capture.tags.length > 0) lines.push(`   Tags: ${capture.tags.join(', ')}`)
  lines.push(`   ${preview}`)
  return lines
}

export async function searchBrainTool(input: SearchBrainInput, searchService: SearchService): Promise<string> {
  const dateFrom = input.days
    ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000)
    : undefined

  const response = await searchService.searchWithRelated(input.query, {
    limit: input.limit,
    brainViews: input.brain_view ? [input.brain_view] : undefined,
    dateFrom,
    includeRelated: input.include_related,
  })

  const results = response.results

  // Apply threshold filter post-search
  const filtered = input.threshold > 0
    ? results.filter(r => r.score >= input.threshold)
    : results

  // Apply source filter post-search
  const sourced = input.source_filter
    ? filtered.filter(r => r.capture.source === input.source_filter)
    : filtered

  if (sourced.length === 0) {
    return `No captures found matching "${input.query}"${input.days ? ` in the last ${input.days} days` : ''}.`
  }

  const lines: string[] = [
    `Search results for: "${input.query}"`,
    `Found ${sourced.length} result${sourced.length !== 1 ? 's' : ''}`,
    '',
  ]

  for (let i = 0; i < sourced.length; i++) {
    lines.push(...formatResult(i + 1, sourced[i]))
    lines.push('')
  }

  // Append related captures from spreading activation (if any)
  const relatedResults = response.relatedResults
  if (relatedResults && relatedResults.length > 0) {
    lines.push('---')
    lines.push(`Related captures (via entity graph): ${relatedResults.length} found`)
    lines.push('')
    for (let i = 0; i < relatedResults.length; i++) {
      lines.push(...formatResult(i + 1, relatedResults[i]))
      lines.push('')
    }
  }

  return lines.join('\n').trimEnd()
}
