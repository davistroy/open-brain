import { z } from 'zod'
import type { SearchService } from '../../services/search.js'

export const searchBrainSchema = z.object({
  query: z.string().min(1).describe('Search query string'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of results to return'),
  threshold: z.number().min(0).max(1).default(0.0).describe('Minimum relevance score threshold (0–1)'),
  source_filter: z.string().optional().describe('Filter by source (e.g. slack, api, voice)'),
  tag_filter: z.array(z.string()).optional().describe('Filter by tags'),
  brain_view: z.string().optional().describe('Filter by brain view (career, personal, technical, work-internal, client)'),
  days: z.number().int().min(1).optional().describe('Limit results to the last N days'),
})

export type SearchBrainInput = z.infer<typeof searchBrainSchema>

export async function searchBrainTool(input: SearchBrainInput, searchService: SearchService): Promise<string> {
  const dateFrom = input.days
    ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000)
    : undefined

  const results = await searchService.search(input.query, {
    limit: input.limit,
    brainViews: input.brain_view ? [input.brain_view] : undefined,
    dateFrom,
  })

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
    const { capture, score } = sourced[i]
    const date = new Date(capture.captured_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    const matchPct = Math.round(score * 100)
    const preview = capture.content.length > 200
      ? capture.content.slice(0, 200).trimEnd() + '…'
      : capture.content

    lines.push(`${i + 1}. [${matchPct}% match] ${capture.capture_type.toUpperCase()} — ${date} (${capture.source})`)
    lines.push(`   ID: ${capture.id}`)
    if (capture.brain_view) lines.push(`   View: ${capture.brain_view}`)
    if (capture.tags && capture.tags.length > 0) lines.push(`   Tags: ${capture.tags.join(', ')}`)
    lines.push(`   ${preview}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
