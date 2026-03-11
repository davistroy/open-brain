import { eq, sql, desc, asc, ne } from 'drizzle-orm'
import { entities, entity_links, captures } from '@open-brain/shared'
import { NotFoundError } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { EntityResolutionService } from './entity-resolution.js'

export interface EntityRecord {
  id: string
  name: string
  entity_type: string
  canonical_name: string
  aliases: string[]
  metadata: unknown
  mention_count: number
  first_seen_at: Date
  last_seen_at: Date
  created_at: Date
  updated_at: Date
}

export interface EntityDetail extends EntityRecord {
  linked_captures: LinkedCapture[]
}

export interface LinkedCapture {
  id: string
  content: string
  capture_type: string
  brain_view: string
  relationship: string | null
  confidence: number | null
  created_at: Date
}

export interface EntityListFilter {
  type_filter?: string
  sort_by?: 'mention_count' | 'last_seen' | 'name'
  limit?: number
  offset?: number
}

export interface EntityListResult {
  items: EntityRecord[]
  total: number
}

/**
 * EntityService — CRUD operations for entities and entity detail views.
 *
 * list()    — paginated entity list with optional type filter and sort.
 * getById() — entity detail with recent linked captures.
 * getByName() — case-insensitive lookup by name.
 * merge()   — delegate to EntityResolutionService.merge().
 * split()   — delegate to EntityResolutionService.split().
 *
 * Note: mention_count is derived at query time from entity_links count.
 * last_seen_at is from the entities table (updated by link-entities pipeline stage).
 */
export class EntityService {
  constructor(
    private db: Database,
    private resolutionService?: EntityResolutionService,
  ) {}

  async list(filter: EntityListFilter = {}): Promise<EntityListResult> {
    const { type_filter, sort_by = 'mention_count', limit = 20, offset = 0 } = filter

    // Build WHERE condition for optional type filter
    const whereCondition = type_filter
      ? eq(entities.entity_type, type_filter)
      : undefined

    // Build ORDER BY expression — mention_count is a computed aggregate alias,
    // so we use sql template for it; others reference Drizzle column refs.
    const orderByExpr =
      sort_by === 'mention_count'
        ? desc(sql`COUNT(${entity_links.id})`)
        : sort_by === 'last_seen'
          ? sql`${entities.last_seen_at} DESC NULLS LAST`
          : asc(entities.name)

    // Derive mention_count from entity_links at query time for accuracy
    // Run data + count queries in parallel (they are independent)
    const [dataRows, countRows] = await Promise.all([
      this.db
        .select({
          id: sql<string>`${entities.id}::text`,
          name: entities.name,
          entity_type: entities.entity_type,
          canonical_name: entities.canonical_name,
          aliases: entities.aliases,
          metadata: entities.metadata,
          first_seen_at: entities.first_seen_at,
          last_seen_at: entities.last_seen_at,
          created_at: entities.created_at,
          updated_at: entities.updated_at,
          mention_count: sql<number>`COUNT(${entity_links.id})::int`,
        })
        .from(entities)
        .leftJoin(entity_links, eq(entity_links.entity_id, entities.id))
        .where(whereCondition)
        .groupBy(entities.id)
        .orderBy(orderByExpr)
        .limit(limit)
        .offset(offset),

      this.db
        .select({ total: sql<string>`count(*)` })
        .from(entities)
        .where(whereCondition),
    ])

    return {
      items: dataRows as EntityRecord[],
      total: Number(countRows[0]?.total ?? 0),
    }
  }

  async getById(id: string): Promise<EntityDetail> {
    const entityRows = await this.db
      .select({
        id: sql<string>`${entities.id}::text`,
        name: entities.name,
        entity_type: entities.entity_type,
        canonical_name: entities.canonical_name,
        aliases: entities.aliases,
        metadata: entities.metadata,
        first_seen_at: entities.first_seen_at,
        last_seen_at: entities.last_seen_at,
        created_at: entities.created_at,
        updated_at: entities.updated_at,
        mention_count: sql<number>`(SELECT COUNT(*)::int FROM entity_links WHERE entity_id = ${id}::uuid)`,
      })
      .from(entities)
      .where(sql`${entities.id} = ${id}::uuid`)
      .limit(1)

    if (entityRows.length === 0) {
      throw new NotFoundError(`Entity not found: ${id}`)
    }

    const entity = entityRows[0] as EntityRecord

    // Fetch up to 20 most recent linked captures
    const linkedCaptures = await this.db
      .select({
        id: sql<string>`${captures.id}::text`,
        content: captures.content,
        capture_type: captures.capture_type,
        brain_view: captures.brain_view,
        relationship: entity_links.relationship,
        confidence: entity_links.confidence,
        created_at: captures.created_at,
      })
      .from(entity_links)
      .innerJoin(captures, eq(captures.id, entity_links.capture_id))
      .where(
        sql`${entity_links.entity_id} = ${id}::uuid AND ${captures.pipeline_status} != 'deleted'`,
      )
      .orderBy(desc(captures.created_at))
      .limit(20)

    return {
      ...entity,
      linked_captures: linkedCaptures as LinkedCapture[],
    }
  }

  async getByName(name: string): Promise<EntityRecord | null> {
    const rows = await this.db
      .select({
        id: sql<string>`${entities.id}::text`,
        name: entities.name,
        entity_type: entities.entity_type,
        canonical_name: entities.canonical_name,
        aliases: entities.aliases,
        metadata: entities.metadata,
        first_seen_at: entities.first_seen_at,
        last_seen_at: entities.last_seen_at,
        created_at: entities.created_at,
        updated_at: entities.updated_at,
        mention_count: sql<number>`(SELECT COUNT(*)::int FROM entity_links WHERE entity_id = ${entities.id})`,
      })
      .from(entities)
      .where(sql`lower(${entities.name}) = lower(${name})`)
      .limit(1)

    if (rows.length === 0) return null
    return rows[0] as EntityRecord
  }

  /**
   * Merge source entity into target. Delegates to EntityResolutionService.
   * All entity_links from source are moved to target; source is deleted.
   */
  async merge(sourceId: string, targetId: string): Promise<void> {
    if (!this.resolutionService) {
      throw new Error('EntityResolutionService not configured')
    }
    await this.resolutionService.merge(sourceId, targetId)
  }

  /**
   * Split an alias out of an entity into a new independent entity.
   * Delegates to EntityResolutionService.
   */
  async split(entityId: string, alias: string): Promise<{ new_entity_id: string }> {
    if (!this.resolutionService) {
      throw new Error('EntityResolutionService not configured')
    }
    return this.resolutionService.split(entityId, alias)
  }

  /**
   * Update last_seen_at for an entity.
   * Called by the link-entities pipeline stage.
   */
  async recordMention(entityId: string): Promise<void> {
    await this.db
      .update(entities)
      .set({
        last_seen_at: new Date(),
        updated_at: new Date(),
      })
      .where(sql`${entities.id} = ${entityId}::uuid`)
  }
}
