import { z } from 'zod'
import type { CaptureService } from '../../services/capture.js'
import type { Database } from '@open-brain/shared'
import { SafePromptBuilder } from '@open-brain/shared'
import { sql } from 'drizzle-orm'

// Module-level sanitizer for MCP return values.
// Using sanitizeInline (not wrapContent) — plain text returned to client LLM.
const _sanitizer = new SafePromptBuilder()

export const getCaptureSchema = z.object({
  id: z.string().uuid().describe('Capture UUID'),
})

export type GetCaptureInput = z.infer<typeof getCaptureSchema>

type LinkedEntity = {
  name: string
  type: string
  relationship: string | null
}

export async function getCaptureTool(input: GetCaptureInput, captureService: CaptureService, db: Database): Promise<string> {
  const capture = await captureService.getById(input.id)

  const date = new Date(capture.captured_at).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const lines: string[] = [
    `Capture — ${capture.capture_type.toUpperCase()}`,
    '='.repeat(50),
    '',
    `ID: ${capture.id}`,
    `Date: ${date}`,
    `Source: ${capture.source}`,
    `View: ${capture.brain_view}`,
    `Pipeline: ${capture.pipeline_status}`,
  ]

  if (capture.tags && capture.tags.length > 0) {
    lines.push(`Tags: ${capture.tags.join(', ')}`)
  }

  if (capture.source_metadata) {
    const meta = capture.source_metadata
    const metaParts: string[] = []
    if ('channel' in meta && meta.channel) metaParts.push(`channel: ${meta.channel}`)
    if ('origin' in meta && meta.origin) metaParts.push(`origin: ${meta.origin}`)
    if ('location' in meta && meta.location) {
      const loc = meta.location as Record<string, unknown>
      if (loc.location_name) metaParts.push(`location: ${loc.location_name}`)
    }
    if (metaParts.length > 0) {
      lines.push(`Metadata: ${metaParts.join(', ')}`)
    }
  }

  const safeContent = _sanitizer.sanitizeInline(capture.content, capture.id ?? 'unknown')
  lines.push('', '--- Content ---', '', safeContent)

  // Fetch linked entities
  try {
    const entityRows = await db.execute<LinkedEntity>(
      sql`SELECT e.name, e.entity_type AS type, el.relationship
          FROM entity_links el
          JOIN entities e ON e.id = el.entity_id
          WHERE el.capture_id = ${input.id}::uuid
          ORDER BY e.name`,
    )

    if (entityRows.rows.length > 0) {
      lines.push('', '--- Linked Entities ---', '')
      for (const entity of entityRows.rows) {
        const rel = entity.relationship ? ` (${entity.relationship})` : ''
        lines.push(`• ${entity.name} [${entity.type}]${rel}`)
      }
    }
  } catch {
    // entity_links table may not exist — skip silently
  }

  return lines.join('\n')
}
