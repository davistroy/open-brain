import { eq } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { captures, pipeline_events } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { resolveOrCreateEntity, linkEntityToCapture, upsertEntityRelationship, dedup } from '../../lib/entity-resolver.js'

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
 * 3. For each mention: resolveOrCreateEntity() → linkEntityToCapture()
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
        const entityId = await resolveOrCreateEntity(db, name, 'person')
        await linkEntityToCapture(db, entityId, captureId, 'mentioned', 0.9)
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
        const entityId = await resolveOrCreateEntity(db, topic, 'concept')
        await linkEntityToCapture(db, entityId, captureId, 'mentioned', 0.85)
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
