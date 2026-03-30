import { eq, sql, and } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { entities, entity_links, logger } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw LLM extraction result — validated before use.
 */
export interface ExtractedEntities {
  people: string[]
  organizations: string[]
  concepts: string[]
  decisions: string[]
  projects: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Map from prompt field name to entity_type stored in DB.
 * Aligns with supported entity_type values in the entities table.
 */
export const ENTITY_TYPE_MAP: Record<keyof ExtractedEntities, string> = {
  people: 'person',
  organizations: 'org',
  concepts: 'concept',
  decisions: 'decision',
  projects: 'project',
}

// ---------------------------------------------------------------------------
// Entity resolution (lightweight two-tier path for pipeline batch processing)
//
// Full three-tier LLM disambiguation lives in EntityResolutionService (12.1).
// The pipeline uses the fast path: exact name/canonical_name -> alias -> create.
// Uses indexed SQL queries per entity — efficient and avoids loading all
// entities of a type into memory.
// ---------------------------------------------------------------------------

/**
 * Resolve or create an entity for a given name + type.
 *
 * Resolution order:
 * 1. Exact name or canonical_name match (case-insensitive) within entity_type
 *    — uses indexed lower() lookups
 * 2. Alias match within entity_type — uses Postgres array contains (@>)
 * 3. No match found -> INSERT new entity
 *
 * Returns the resolved entity id.
 */
export async function resolveOrCreateEntity(
  db: Database,
  name: string,
  entityType: string,
): Promise<string> {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('Entity name must not be empty')

  const lowerName = normalizedName.toLowerCase()

  // Tier 1: Exact case-insensitive name or canonical_name match via indexed lower() lookup.
  // Uses (entity_type, lower(name)) and (entity_type, lower(canonical_name)) indexes.
  const [byName] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.entity_type, entityType),
        sql`(lower(${entities.name}) = ${lowerName} OR lower(${entities.canonical_name}) = ${lowerName})`,
      ),
    )
    .limit(1)

  if (byName) {
    await db
      .update(entities)
      .set({ last_seen_at: new Date(), updated_at: new Date() })
      .where(eq(entities.id, byName.id))
    return byName.id
  }

  // Tier 2: Alias match using Postgres array contains operator (@>).
  // Checks whether the aliases array column contains the lowercased mention.
  const [byAlias] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.entity_type, entityType),
        sql`${entities.aliases} @> ARRAY[${lowerName}]::text[]`,
      ),
    )
    .limit(1)

  if (byAlias) {
    await db
      .update(entities)
      .set({ last_seen_at: new Date(), updated_at: new Date() })
      .where(eq(entities.id, byAlias.id))
    return byAlias.id
  }

  // 3. Create new entity
  const [inserted] = await db
    .insert(entities)
    .values({
      name: normalizedName,
      entity_type: entityType,
      canonical_name: normalizedName,
      aliases: [],
      metadata: null,
    })
    .returning({ id: entities.id })

  if (!inserted) {
    throw new Error(`[entity-resolver] INSERT entity failed for name="${normalizedName}" type="${entityType}"`)
  }

  logger.debug(
    { entityId: inserted.id, name: normalizedName, entityType },
    '[entity-resolver] new entity created',
  )

  return inserted.id
}

// ---------------------------------------------------------------------------
// entity_links upsert — idempotent
// ---------------------------------------------------------------------------

/**
 * Create an entity_link between an entity and a capture (upsert — idempotent).
 * If the link already exists (unique constraint), the conflict is silently ignored.
 */
export async function linkEntityToCapture(
  db: Database,
  entityId: string,
  captureId: string,
  relationship: string,
  confidence: number,
): Promise<void> {
  try {
    await db
      .insert(entity_links)
      .values({
        entity_id: entityId,
        capture_id: captureId,
        relationship,
        confidence,
      })
      .onConflictDoNothing()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(
      { entityId, captureId, err: msg },
      '[entity-resolver] entity_link insert conflict — skipping',
    )
  }
}

// ---------------------------------------------------------------------------
// entity_relationships upsert — co-occurrence graph
//
// Canonical ordering: entity_id_a is the lexicographically smaller UUID.
// On conflict (pair already exists): increment co_occurrence_count, bump
// last_seen_at and updated_at.  weight is set to co_occurrence_count so
// downstream graph queries can filter by relationship strength without a
// separate normalization pass.
// ---------------------------------------------------------------------------

export async function upsertEntityRelationship(
  db: Database,
  idA: string,
  idB: string,
): Promise<void> {
  if (idA === idB) return // self-loops are meaningless

  // Enforce canonical ordering so (A,B) and (B,A) are the same row.
  const [smaller, larger] = idA < idB ? [idA, idB] : [idB, idA]

  await db.execute(
    sql`
      INSERT INTO entity_relationships
        (id, entity_id_a, entity_id_b, co_occurrence_count, weight, last_seen_at, created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${smaller}::uuid, ${larger}::uuid, 1, 1.0, now(), now(), now())
      ON CONFLICT (entity_id_a, entity_id_b)
      DO UPDATE SET
        co_occurrence_count = entity_relationships.co_occurrence_count + 1,
        weight              = entity_relationships.co_occurrence_count + 1,
        last_seen_at        = now(),
        updated_at          = now()
    `,
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deduplicate an array of strings case-insensitively, preserving the first
 * occurrence's original casing.
 */
export function dedup(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const key = item.trim().toLowerCase()
    if (key && !seen.has(key)) {
      seen.add(key)
      result.push(item.trim())
    }
  }
  return result
}
