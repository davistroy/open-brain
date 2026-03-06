import { eq, sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { captures, entities, entity_links, entity_relationships, pipeline_events } from '@open-brain/shared'
import { logger } from '../../lib/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured metadata produced by the extract_metadata pipeline stage and
 * stored in captures.source_metadata (or captures.pre_extracted for voice).
 * Only the fields relevant to entity linking are typed here.
 */
interface CaptureMetadata {
  people?: string[]
  topics?: string[]
  [key: string]: unknown
}

/**
 * Result of resolving a single entity mention against the entities table.
 */
interface ResolvedEntity {
  id: string
  entityType: string
  name: string
}

// ---------------------------------------------------------------------------
// Entity resolution (lightweight two-tier path for pipeline batch processing)
//
// Full three-tier LLM disambiguation lives in EntityResolutionService (12.1).
// The pipeline stage uses the fast path: exact name/canonical_name → alias.
// New entities are created on first mention. This keeps pipeline latency low
// and avoids LLM calls during the synchronous pipeline run.
// ---------------------------------------------------------------------------

async function resolveOrCreateEntityForStage(
  db: Database,
  name: string,
  entityType: string,
): Promise<string> {
  const normalized = name.trim()
  if (!normalized) throw new Error('Entity name must not be empty')

  const lower = normalized.toLowerCase()

  const candidates = await db
    .select({
      id: entities.id,
      name: entities.name,
      canonical_name: entities.canonical_name,
      aliases: entities.aliases,
    })
    .from(entities)
    .where(eq(entities.entity_type, entityType))

  // 1. Exact name or canonical_name match (case-insensitive)
  const byName = candidates.find(
    (c) =>
      c.name.toLowerCase() === lower ||
      c.canonical_name.toLowerCase() === lower,
  )
  if (byName) {
    await db
      .update(entities)
      .set({ last_seen_at: new Date(), updated_at: new Date() })
      .where(eq(entities.id, byName.id))
    return byName.id
  }

  // 2. Alias match
  const byAlias = candidates.find((c) =>
    (c.aliases as string[]).some((alias) => alias.toLowerCase() === lower),
  )
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
      name: normalized,
      entity_type: entityType,
      canonical_name: normalized,
      aliases: [],
      metadata: null,
    })
    .returning({ id: entities.id })

  if (!inserted) {
    throw new Error(
      `[link-entities] INSERT entity failed for name="${normalized}" type="${entityType}"`,
    )
  }

  logger.debug(
    { entityId: inserted.id, name: normalized, entityType },
    '[link-entities] new entity created',
  )

  return inserted.id
}

// ---------------------------------------------------------------------------
// entity_links upsert — idempotent
// ---------------------------------------------------------------------------

async function upsertEntityLink(
  db: Database,
  entityId: string,
  captureId: string,
  relationship: string,
  confidence: number,
): Promise<void> {
  await db
    .insert(entity_links)
    .values({ entity_id: entityId, capture_id: captureId, relationship, confidence })
    .onConflictDoNothing()
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

async function upsertEntityRelationship(
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
// Main stage handler
// ---------------------------------------------------------------------------

/**
 * Link-entities pipeline stage.
 *
 * Called after extract_metadata. Reads entity mentions from capture metadata
 * (people → 'person', topics → 'concept'), resolves each via the two-tier
 * fast path (exact/alias/create), upserts entity_links, and builds the
 * entity co-occurrence graph in entity_relationships.
 *
 * Algorithm:
 * 1. Load capture + source_metadata (populated by extract_metadata stage)
 * 2. Collect mentions: metadata.people → 'person', metadata.topics → 'concept'
 * 3. For each mention: resolveOrCreateEntityForStage() → entity_links upsert
 * 4. For each pair of resolved entity IDs: upsertEntityRelationship()
 * 5. Record pipeline_events stage result
 *
 * Failures:
 * - Capture not found → log warn, return (idempotent skip)
 * - Individual mention resolution failure → log warn, skip mention, continue
 * - Relationship upsert failure → log warn, skip pair, continue
 * - Total stage failure → log error, record failed event, rethrow (caller decides retry)
 *
 * This stage is non-blocking: a failure here is logged and recorded but must
 * not prevent the capture from reaching pipeline_status = 'complete'. The
 * caller (pipeline runner or job handler) is responsible for catch-and-continue.
 */
export async function processLinkEntitiesStage(
  captureId: string,
  db: Database,
): Promise<void> {
  const start = Date.now()

  logger.info({ captureId }, '[link-entities] stage started')

  // ── Fetch capture metadata ─────────────────────────────────────────────────
  const [capture] = await db
    .select({
      id: captures.id,
      source_metadata: captures.source_metadata,
      pre_extracted: captures.pre_extracted,
    })
    .from(captures)
    .where(eq(captures.id, captureId))
    .limit(1)

  if (!capture) {
    logger.warn({ captureId }, '[link-entities] capture not found — skipping')
    return
  }

  await db.insert(pipeline_events).values({
    capture_id: captureId,
    stage: 'link_entities',
    status: 'started',
  })

  try {
    // ── Collect entity mentions from metadata ────────────────────────────────
    // extract_metadata stage writes enriched fields into source_metadata.
    // voice-capture pre_extracted also carries people/topics arrays.
    const metadata: CaptureMetadata =
      (capture.source_metadata as CaptureMetadata | null) ?? {}
    const preExtracted: CaptureMetadata =
      (capture.pre_extracted as CaptureMetadata | null) ?? {}

    // Merge people/topics from both sources, dedup by lowercase value.
    const peopleMentions = dedup([
      ...(metadata.people ?? []),
      ...(preExtracted.people ?? []),
    ])
    const topicMentions = dedup([
      ...(metadata.topics ?? []),
      ...(preExtracted.topics ?? []),
    ])

    const totalMentions = peopleMentions.length + topicMentions.length

    logger.debug(
      { captureId, people: peopleMentions.length, topics: topicMentions.length },
      '[link-entities] mentions collected',
    )

    // ── Resolve entities and upsert entity_links ─────────────────────────────
    const resolved: ResolvedEntity[] = []

    for (const name of peopleMentions) {
      try {
        const entityId = await resolveOrCreateEntityForStage(db, name, 'person')
        await upsertEntityLink(db, entityId, captureId, 'mentioned', 0.9)
        resolved.push({ id: entityId, entityType: 'person', name })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(
          { captureId, name, entityType: 'person', err: msg },
          '[link-entities] failed to resolve person mention — skipping',
        )
      }
    }

    for (const topic of topicMentions) {
      try {
        const entityId = await resolveOrCreateEntityForStage(db, topic, 'concept')
        await upsertEntityLink(db, entityId, captureId, 'mentioned', 0.85)
        resolved.push({ id: entityId, entityType: 'concept', name: topic })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(
          { captureId, name: topic, entityType: 'concept', err: msg },
          '[link-entities] failed to resolve topic mention — skipping',
        )
      }
    }

    // ── Build co-occurrence graph (entity_relationships) ─────────────────────
    // Every pair of entities that appear in the same capture gets a
    // strengthened relationship edge.
    let relationshipCount = 0
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const idA = resolved[i]!.id
        const idB = resolved[j]!.id
        try {
          await upsertEntityRelationship(db, idA, idB)
          relationshipCount++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(
            { captureId, idA, idB, err: msg },
            '[link-entities] failed to upsert entity relationship — skipping pair',
          )
        }
      }
    }

    // ── Record stage success ─────────────────────────────────────────────────
    const durationMs = Date.now() - start

    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'link_entities',
      status: 'success',
      duration_ms: durationMs,
      metadata: {
        people_count: peopleMentions.length,
        topic_count: topicMentions.length,
        entities_resolved: resolved.length,
        relationships_upserted: relationshipCount,
        total_mentions: totalMentions,
      },
    })

    logger.info(
      {
        captureId,
        duration_ms: durationMs,
        entities_resolved: resolved.length,
        relationships_upserted: relationshipCount,
      },
      '[link-entities] stage complete',
    )
  } catch (err) {
    const durationMs = Date.now() - start
    const errMsg = err instanceof Error ? err.message : String(err)

    await db.insert(pipeline_events).values({
      capture_id: captureId,
      stage: 'link_entities',
      status: 'failed',
      duration_ms: durationMs,
      error: errMsg,
    })

    logger.error({ captureId, err }, '[link-entities] stage failed')
    throw err
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deduplicate an array of strings case-insensitively, preserving the first
 * occurrence's original casing.
 */
function dedup(items: string[]): string[] {
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
