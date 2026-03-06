import { z } from 'zod'
import type { Database } from '@open-brain/shared'
import { sql } from 'drizzle-orm'
import type { EntityService } from '../../services/entity.js'

const getEntityBaseSchema = z.object({
  name: z.string().optional().describe('Entity name to look up'),
  id: z.string().uuid().optional().describe('Entity UUID'),
})

export const getEntitySchema = getEntityBaseSchema.refine(d => d.name !== undefined || d.id !== undefined, {
  message: 'Either name or id must be provided',
})

/** Raw ZodObject shape (without refine) for use with MCP server.tool() */
export const getEntitySchemaShape = getEntityBaseSchema.shape

export type GetEntityInput = z.infer<typeof getEntitySchema>

interface EntityRow {
  id: string
  name: string
  entity_type: string
  mention_count: number
  last_seen_at: string | null
  metadata: unknown
}

export async function getEntityTool(
  input: GetEntityInput,
  db: Database,
  entityService?: EntityService,
): Promise<string> {
  // Use EntityService (Phase 12) when available for richer output
  if (entityService) {
    try {
      let detail
      if (input.id) {
        detail = await entityService.getById(input.id)
      } else {
        const entity = await entityService.getByName(input.name!)
        if (!entity) {
          return `No entity found for "${input.name}". Entities are extracted automatically from captures during the pipeline stage.`
        }
        detail = await entityService.getById(entity.id)
      }

      const lastSeen = detail.last_seen_at
        ? new Date(detail.last_seen_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : 'unknown'

      const lines = [
        `Entity: ${detail.name}`,
        `Type:   ${detail.entity_type}`,
        `ID:     ${detail.id}`,
        `Mentions: ${detail.mention_count}`,
        `Last seen: ${lastSeen}`,
        `Aliases: ${detail.aliases.join(', ') || 'none'}`,
        '',
        `Recent captures (${detail.linked_captures.length}):`,
      ]

      for (const cap of detail.linked_captures.slice(0, 5)) {
        const date = new Date(cap.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        const snippet = cap.content.length > 120 ? cap.content.slice(0, 120) + '…' : cap.content
        lines.push(`  [${date}] [${cap.capture_type}] ${snippet}`)
      }

      if (detail.linked_captures.length > 5) {
        lines.push(`  … and ${detail.linked_captures.length - 5} more`)
      }

      return lines.join('\n')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not found') || message.includes('NOT_FOUND')) {
        const identifier = input.id ?? input.name
        return `No entity found for "${identifier}". Entities are extracted automatically from captures during the pipeline stage.`
      }
      throw err
    }
  }

  // Fallback: direct SQL (pre-Phase 12 or EntityService unavailable)
  let rows: EntityRow[]

  try {
    if (input.id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await db.execute<any>(
        sql`SELECT id::text, name, entity_type, mention_count, last_seen_at, metadata FROM entities WHERE id = ${input.id}::uuid LIMIT 1`,
      )
      rows = result.rows
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await db.execute<any>(
        sql`SELECT id::text, name, entity_type, mention_count, last_seen_at, metadata FROM entities WHERE lower(name) = lower(${input.name!}) LIMIT 1`,
      )
      rows = result.rows
    }
  } catch {
    // entities table may not exist yet (implemented in Phase 12)
    return `Entity lookup is not yet available. The entity graph is implemented in a later phase.`
  }

  if (rows.length === 0) {
    const identifier = input.id ?? input.name
    return `No entity found for "${identifier}". Entities are extracted automatically from captures during the pipeline stage.`
  }

  const entity = rows[0]
  const lastSeen = entity.last_seen_at
    ? new Date(entity.last_seen_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'unknown'

  const lines = [
    `Entity: ${entity.name}`,
    `Type:   ${entity.entity_type}`,
    `ID:     ${entity.id}`,
    `Mentions: ${entity.mention_count}`,
    `Last seen: ${lastSeen}`,
  ]

  return lines.join('\n')
}
