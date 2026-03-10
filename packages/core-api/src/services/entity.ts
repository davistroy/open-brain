import { sql } from 'drizzle-orm'
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

    const orderExpr =
      sort_by === 'mention_count'
        ? sql`mention_count DESC`
        : sort_by === 'last_seen'
          ? sql`last_seen_at DESC NULLS LAST`
          : sql`name ASC`

    const typeClause = type_filter
      ? sql`WHERE e.entity_type = ${type_filter}`
      : sql``

    // Derive mention_count from entity_links at query time for accuracy
    // Run data + count queries in parallel (they are independent)
    const [rows, countRows] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.db.execute<any>(
        sql`SELECT
              e.id::text,
              e.name,
              e.entity_type,
              e.canonical_name,
              e.aliases,
              e.metadata,
              e.first_seen_at,
              e.last_seen_at,
              e.created_at,
              e.updated_at,
              COUNT(el.id)::int AS mention_count
            FROM entities e
            LEFT JOIN entity_links el ON el.entity_id = e.id
            ${typeClause}
            GROUP BY e.id
            ORDER BY ${orderExpr}
            LIMIT ${limit} OFFSET ${offset}`,
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.db.execute<any>(
        type_filter
          ? sql`SELECT COUNT(*)::text AS total FROM entities WHERE entity_type = ${type_filter}`
          : sql`SELECT COUNT(*)::text AS total FROM entities`,
      ),
    ])

    return {
      items: rows.rows as unknown as EntityRecord[],
      total: Number(countRows.rows[0]?.total ?? 0),
    }
  }

  async getById(id: string): Promise<EntityDetail> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entityRows = await this.db.execute<any>(
      sql`SELECT
            id::text, name, entity_type, canonical_name, aliases,
            metadata, first_seen_at, last_seen_at, created_at, updated_at,
            (SELECT COUNT(*)::int FROM entity_links WHERE entity_id = ${id}::uuid) AS mention_count
          FROM entities
          WHERE id = ${id}::uuid
          LIMIT 1`,
    )

    if (entityRows.rows.length === 0) {
      throw new NotFoundError(`Entity not found: ${id}`)
    }

    const entity = entityRows.rows[0] as unknown as EntityRecord

    // Fetch up to 20 most recent linked captures
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captureRows = await this.db.execute<any>(
      sql`SELECT
            c.id::text,
            c.content,
            c.capture_type,
            c.brain_view,
            el.relationship,
            el.confidence,
            c.created_at
          FROM entity_links el
          JOIN captures c ON c.id = el.capture_id
          WHERE el.entity_id = ${id}::uuid
            AND c.pipeline_status != 'deleted'
          ORDER BY c.created_at DESC
          LIMIT 20`,
    )

    return {
      ...entity,
      linked_captures: captureRows.rows as unknown as LinkedCapture[],
    }
  }

  async getByName(name: string): Promise<EntityRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await this.db.execute<any>(
      sql`SELECT
            id::text, name, entity_type, canonical_name, aliases,
            metadata, first_seen_at, last_seen_at, created_at, updated_at,
            (SELECT COUNT(*)::int FROM entity_links WHERE entity_id = entities.id) AS mention_count
          FROM entities
          WHERE lower(name) = lower(${name})
          LIMIT 1`,
    )

    if (rows.rows.length === 0) return null
    return rows.rows[0] as unknown as EntityRecord
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
   * Update last_seen_at and increment mention_count for an entity.
   * Called by the link-entities pipeline stage.
   */
  async recordMention(entityId: string): Promise<void> {
    await this.db.execute(
      sql`UPDATE entities
          SET last_seen_at = now(),
              updated_at   = now()
          WHERE id = ${entityId}::uuid`,
    )
  }
}
