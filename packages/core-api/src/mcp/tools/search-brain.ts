import { z } from 'zod'
import type { Queue } from 'bullmq'
import { logger, SafePromptBuilder } from '@open-brain/shared'
import type { SearchService } from '../../services/search.js'
import type { SearchResult } from '../../services/search.js'

// Module-level sanitizer for MCP return values.
// Using sanitizeInline (not wrapContent) — MCP responses are plain text read by the
// client LLM; XML delimiters from wrapContent would appear as literals in tool output.
const _sanitizer = new SafePromptBuilder()

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
  const safeContent = _sanitizer.sanitizeInline(capture.content, capture.id ?? 'unknown')
  const preview = safeContent.length > 500
    ? safeContent.slice(0, 500).trimEnd() + '…'
    : safeContent

  const lines: string[] = []
  lines.push(`${index}. [${matchPct}% match] ${capture.capture_type.toUpperCase()} — ${date} (${capture.source})`)
  lines.push(`   ID: ${capture.id}`)
  if (capture.brain_view) lines.push(`   View: ${capture.brain_view}`)
  if (capture.tags && capture.tags.length > 0) lines.push(`   Tags: ${capture.tags.join(', ')}`)
  lines.push(`   ${preview}`)
  return lines
}

export async function searchBrainTool(
  input: SearchBrainInput,
  searchService: SearchService,
  accessStatsQueue?: Queue<{ captureIds: string[]; accessedAt: string }>,
): Promise<string> {
  const dateFrom = input.days
    ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000)
    : undefined

  const response = await searchService.searchWithRelated(input.query, {
    limit: input.limit,
    brainViews: input.brain_view ? [input.brain_view] : undefined,
    dateFrom,
    includeRelated: input.include_related,
  })

  if (accessStatsQueue && response.results.length > 0) {
    const captureIds = response.results.slice(0, 10).map(r => r.capture.id!)
    accessStatsQueue.add('access-stats', {
      captureIds,
      accessedAt: new Date().toISOString(),
    }).catch(err => logger.debug({ err }, '[search-brain] access-stats enqueue failed (fire-and-forget)'))
  }

  const results = response.results

  // Apply threshold filter post-search
  const filtered = input.threshold > 0
    ? results.filter(r => r.score >= input.threshold)
    : results

  // Apply source filter post-search
  const sourced = input.source_filter
    ? filtered.filter(r => r.capture.source === input.source_filter)
    : filtered

  // Apply tag filter post-search (AND semantics: capture must contain every requested tag)
  const tagged = input.tag_filter && input.tag_filter.length > 0
    ? sourced.filter(r => {
        const captureTags: string[] = r.capture.tags ?? []
        return (input.tag_filter as string[]).every(t => captureTags.includes(t))
      })
    : sourced

  if (tagged.length === 0) {
    return `No captures found matching "${input.query}"${input.days ? ` in the last ${input.days} days` : ''}.`
  }

  const lines: string[] = [
    `Search results for: "${input.query}"`,
    `Found ${tagged.length} result${tagged.length !== 1 ? 's' : ''}`,
    '',
  ]

  for (let i = 0; i < tagged.length; i++) {
    lines.push(...formatResult(i + 1, tagged[i]))
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
