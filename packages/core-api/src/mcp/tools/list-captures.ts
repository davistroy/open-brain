import { z } from 'zod'
import type { CaptureService } from '../../services/capture.js'

export const listCapturesSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe('Number of captures to return'),
  type: z.string().optional().describe('Filter by capture type (decision, idea, observation, task, win, blocker, question, reflection)'),
  source: z.string().optional().describe('Filter by source (slack, api, voice)'),
  days: z.number().int().min(1).optional().describe('Limit to captures from the last N days'),
})

export type ListCapturesInput = z.infer<typeof listCapturesSchema>

export async function listCapturesTool(input: ListCapturesInput, captureService: CaptureService): Promise<string> {
  const dateFrom = input.days
    ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000)
    : undefined

  const { items, total } = await captureService.list(
    {
      capture_type: input.type as any,
      source: input.source as any,
      date_from: dateFrom,
    },
    input.limit,
    0,
  )

  if (items.length === 0) {
    return `No captures found${input.type ? ` of type "${input.type}"` : ''}${input.days ? ` in the last ${input.days} days` : ''}.`
  }

  const lines: string[] = [
    `Captures (showing ${items.length} of ${total} total)`,
    '',
  ]

  for (const capture of items) {
    const date = new Date(capture.captured_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    const preview = capture.content.length > 150
      ? capture.content.slice(0, 150).trimEnd() + '…'
      : capture.content

    lines.push(`• [${capture.capture_type.toUpperCase()}] ${date} | ${capture.source} | status: ${capture.pipeline_status}`)
    lines.push(`  ID: ${capture.id}`)
    if (capture.brain_view) lines.push(`  View: ${capture.brain_view}`)
    if (capture.tags && capture.tags.length > 0) lines.push(`  Tags: ${capture.tags.join(', ')}`)
    lines.push(`  ${preview}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
