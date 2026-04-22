import type { Hono } from 'hono'
import { z } from 'zod'
import { NotFoundError, ValidationError } from '@open-brain/shared'
import type { EntityService } from '../services/entity.js'
import { logger } from '@open-brain/shared'

/**
 * Register entity management API routes.
 *
 * GET  /api/v1/entities              — list entities (type_filter, sort_by, limit, offset)
 * GET  /api/v1/entities/:id          — entity detail with linked captures
 * GET  /api/v1/entities?name=<name>  — lookup by name (redirects to detail)
 * POST /api/v1/entities/:id/merge    — merge two entities
 * POST /api/v1/entities/:id/split    — split alias to new entity
 */
export function registerEntityRoutes(app: Hono, entityService: EntityService): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/entities
  // List entities with optional filters.
  // Query params: type_filter, sort_by (mention_count|last_seen|name),
  //               limit (default 20, max 100), offset (default 0), name
  // -------------------------------------------------------------------------
  app.get('/api/v1/entities', async (c) => {
    const name = c.req.query('name')

    // If ?name= is provided, return the specific entity by name
    if (name) {
      const entity = await entityService.getByName(name.trim())
      if (!entity) {
        return c.json({ error: `Entity not found: ${name}`, code: 'NOT_FOUND' }, 404)
      }
      return c.json({ entity })
    }

    const typeFilter = c.req.query('type_filter')
    const sortByRaw = c.req.query('sort_by') ?? 'mention_count'
    const limitRaw = c.req.query('limit')
    const offsetRaw = c.req.query('offset')

    const validSortBy = ['mention_count', 'last_seen', 'name'] as const
    type SortBy = (typeof validSortBy)[number]
    const sortBy: SortBy = validSortBy.includes(sortByRaw as SortBy)
      ? (sortByRaw as SortBy)
      : 'mention_count'

    const limit = Math.min(Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 20, 100)
    const offset = Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : 0

    const result = await entityService.list({
      type_filter: typeFilter,
      sort_by: sortBy,
      limit,
      offset,
    })

    return c.json({
      items: result.items,
      total: result.total,
      limit,
      offset,
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/entities/:id
  // Returns entity detail with up to 20 most recent linked captures.
  // -------------------------------------------------------------------------
  app.get('/api/v1/entities/:id', async (c) => {
    const id = c.req.param('id')
    const detail = await entityService.getById(id)
    return c.json(detail)
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/entities/:id/related
  // Returns entities that co-occur with entity :id via shared non-deleted captures.
  // Query params: limit (default 20, max 100)
  // -------------------------------------------------------------------------
  app.get('/api/v1/entities/:id/related', async (c) => {
    const id = c.req.param('id')

    // Basic UUID format guard — reject clearly malformed IDs early
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(id)) {
      return c.json({ error: `Entity not found: ${id}`, code: 'NOT_FOUND' }, 404)
    }

    const limitRaw = c.req.query('limit')
    const limit = Math.min(Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 20, 100)

    const exists = await entityService.entityExists(id)
    if (!exists) {
      return c.json({ error: `Entity not found: ${id}`, code: 'NOT_FOUND' }, 404)
    }

    const related = await entityService.getRelated(id, limit)
    return c.json({ related })
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/entities/:id/mentions-timeline
  // Time-bucketed mention counts for a given entity.
  // Query params: window (7d|30d|90d|365d, default 30d), bucket (day|week|month, default week)
  // Returns only non-zero buckets; client must zero-fill for chart rendering.
  // Rejects the combo bucket=day + window=365d (>52 data points, use week instead).
  // -------------------------------------------------------------------------

  // Zod schema with cross-field refinement — validated here, not in service layer
  const MentionsTimelineQuerySchema = z
    .object({
      window: z.enum(['7d', '30d', '90d', '365d']).default('30d'),
      bucket: z.enum(['day', 'week', 'month']).default('week'),
    })
    .refine(
      (data) => !(data.bucket === 'day' && data.window === '365d'),
      {
        message: 'bucket=day is not allowed with window=365d — use bucket=week or bucket=month',
        path: ['bucket'],
      },
    )

  app.get('/api/v1/entities/:id/mentions-timeline', async (c) => {
    const id = c.req.param('id')

    // Parse and validate query params
    const rawWindow = c.req.query('window') ?? '30d'
    const rawBucket = c.req.query('bucket') ?? 'week'
    const parsed = MentionsTimelineQuerySchema.safeParse({ window: rawWindow, bucket: rawBucket })

    if (!parsed.success) {
      const message = parsed.error.errors.map((e) => e.message).join('; ')
      return c.json({ error: message, code: 'VALIDATION_ERROR' }, 400)
    }

    const { window, bucket } = parsed.data

    // 404 check before expensive aggregation
    const exists = await entityService.entityExists(id)
    if (!exists) {
      return c.json({ error: `Entity not found: ${id}`, code: 'NOT_FOUND' }, 404)
    }

    const buckets = await entityService.getMentionsTimeline(id, window, bucket)

    return c.json({ buckets, window, bucket })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/entities/:id/merge
  // Merge entity :id (source) into target_id.
  // Body: { target_id: string }
  // All entity_links from source are moved to target; source entity deleted.
  // -------------------------------------------------------------------------
  app.post('/api/v1/entities/:id/merge', async (c) => {
    const sourceId = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { target_id } = body as { target_id?: string }

    if (!target_id || typeof target_id !== 'string' || target_id.trim().length === 0) {
      return c.json({ error: 'target_id is required', code: 'VALIDATION_ERROR' }, 400)
    }

    if (sourceId === target_id.trim()) {
      return c.json({ error: 'source and target entities must be different', code: 'VALIDATION_ERROR' }, 400)
    }

    logger.info({ sourceId, targetId: target_id }, '[entities-api] merging entities')

    await entityService.merge(sourceId, target_id.trim())

    logger.info({ sourceId, targetId: target_id }, '[entities-api] merge complete')

    return c.json({
      message: `Entity ${sourceId} merged into ${target_id}`,
      source_id: sourceId,
      target_id: target_id.trim(),
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/entities/:id/split
  // Split an alias out of entity :id into a new entity.
  // Body: { alias: string }
  // -------------------------------------------------------------------------
  app.post('/api/v1/entities/:id/split', async (c) => {
    const entityId = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { alias } = body as { alias?: string }

    if (!alias || typeof alias !== 'string' || alias.trim().length === 0) {
      return c.json({ error: 'alias is required', code: 'VALIDATION_ERROR' }, 400)
    }

    logger.info({ entityId, alias }, '[entities-api] splitting entity')

    const result = await entityService.split(entityId, alias.trim())

    logger.info({ entityId, alias, newEntityId: result.new_entity_id }, '[entities-api] split complete')

    return c.json({
      message: `Alias "${alias}" split into new entity`,
      source_entity_id: entityId,
      new_entity_id: result.new_entity_id,
      alias,
    }, 201)
  })
}
