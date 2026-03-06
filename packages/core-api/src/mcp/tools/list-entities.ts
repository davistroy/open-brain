import { z } from 'zod'
import type { Database } from '@open-brain/shared'
import { sql } from 'drizzle-orm'
import type { EntityService } from '../../services/entity.js'

export const listEntitiesSchema = z.object({
  type_filter: z.string().optional().describe('Filter by entity type (person, organization, project, location, concept)'),
  sort_by: z.enum(['mention_count', 'last_seen', 'name']).default('mention_count').describe('Sort order'),
  limit: z.number().int().min(1).max(100).default(20).describe('Number of entities to return'),
})

export type ListEntitiesInput = z.infer<typeof listEntitiesSchema>

interface EntityRow {
  id: string
  name: string
  entity_type: string
  mention_count: number
  last_seen_at: string | null
}

export async function listEntitiesTool(
  input: ListEntitiesInput,
  db: Database,
  entityService?: EntityService,
): Promise<string> {
  // Use EntityService (Phase 12) when available
  if (entityService) {
    const result = await entityService.list({
      type_filter: input.type_filter,
      sort_by: input.sort_by,
      limit: input.limit,
    })

    if (result.items.length === 0) {
      return `No entities found${input.type_filter ? ` of type "${input.type_filter}"` : ''}. Entities are extracted from captures during pipeline processing.`
    }

    const lines: string[] = [
      `Entities (sorted by ${input.sort_by}, ${result.items.length} shown of ${result.total})`,
      '',
    ]

    for (const entity of result.items) {
      const lastSeen = entity.last_seen_at
        ? new Date(entity.last_seen_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'never'
      lines.push(`• ${entity.name} [${entity.entity_type}] — ${entity.mention_count} mentions, last seen ${lastSeen}`)
      lines.push(`  ID: ${entity.id}`)
    }

    return lines.join('\n')
  }

  // Fallback: direct SQL (pre-Phase 12 or EntityService unavailable)
  let rows: EntityRow[]

  try {
    const orderCol = input.sort_by === 'mention_count'
      ? sql`mention_count DESC`
      : input.sort_by === 'last_seen'
        ? sql`last_seen_at DESC NULLS LAST`
        : sql`name ASC`

    if (input.type_filter) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await db.execute<any>(
        sql`SELECT id::text, name, entity_type, mention_count, last_seen_at FROM entities WHERE entity_type = ${input.type_filter} ORDER BY ${orderCol} LIMIT ${input.limit}`,
      )
      rows = result.rows
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await db.execute<any>(
        sql`SELECT id::text, name, entity_type, mention_count, last_seen_at FROM entities ORDER BY ${orderCol} LIMIT ${input.limit}`,
      )
      rows = result.rows
    }
  } catch {
    // entities table may not exist yet (Phase 12)
    return `Entity list is not yet available. The entity graph is implemented in a later phase.\n\nOnce captures have been processed, entities (people, organizations, projects) will be automatically extracted and linked.`
  }

  if (rows.length === 0) {
    return `No entities found${input.type_filter ? ` of type "${input.type_filter}"` : ''}. Entities are extracted from captures during pipeline processing.`
  }

  const lines: string[] = [
    `Entities (sorted by ${input.sort_by}, ${rows.length} shown)`,
    '',
  ]

  for (const entity of rows) {
    const lastSeen = entity.last_seen_at
      ? new Date(entity.last_seen_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'never'
    lines.push(`• ${entity.name} [${entity.entity_type}] — ${entity.mention_count} mentions, last seen ${lastSeen}`)
    lines.push(`  ID: ${entity.id}`)
  }

  return lines.join('\n')
}
