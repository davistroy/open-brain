import { z } from 'zod'
import type { Database } from '@open-brain/shared'
import { sql } from 'drizzle-orm'

export const getEntitySchema = z.object({
  name: z.string().optional().describe('Entity name to look up'),
  id: z.string().uuid().optional().describe('Entity UUID'),
}).refine(d => d.name !== undefined || d.id !== undefined, {
  message: 'Either name or id must be provided',
})

export type GetEntityInput = z.infer<typeof getEntitySchema>

interface EntityRow {
  id: string
  name: string
  entity_type: string
  mention_count: number
  last_seen_at: string | null
  metadata: unknown
}

export async function getEntityTool(input: GetEntityInput, db: Database): Promise<string> {
  let rows: EntityRow[]

  try {
    if (input.id) {
      const result = await db.execute<EntityRow>(
        sql`SELECT id::text, name, entity_type, mention_count, last_seen_at, metadata FROM entities WHERE id = ${input.id}::uuid LIMIT 1`,
      )
      rows = result.rows
    } else {
      const result = await db.execute<EntityRow>(
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
