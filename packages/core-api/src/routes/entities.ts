import type { Hono } from 'hono'
import { NotFoundError, ValidationError } from '@open-brain/shared'
import type { EntityService } from '../services/entity.js'
import { logger } from '../lib/logger.js'

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
