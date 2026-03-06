import type { Hono } from 'hono'
import { NotFoundError, ValidationError } from '@open-brain/shared'
import type { TriggerService } from '../services/trigger.js'
import { logger } from '../lib/logger.js'

/**
 * Register trigger management API routes.
 *
 * GET    /api/v1/triggers          — list all triggers
 * POST   /api/v1/triggers          — create trigger (generates embedding from queryText)
 * DELETE /api/v1/triggers/:id      — soft-deactivate trigger
 * POST   /api/v1/triggers/test     — test trigger against existing captures (no fire)
 */
export function registerTriggerRoutes(app: Hono, triggerService: TriggerService): void {
  // -----------------------------------------------------------------------
  // GET /api/v1/triggers
  // Returns all triggers (active and inactive) with status metadata.
  // -----------------------------------------------------------------------
  app.get('/api/v1/triggers', async (c) => {
    const triggers = await triggerService.list()
    return c.json({ triggers })
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/triggers
  // Creates a new trigger. Generates embedding from queryText.
  // Body: { name: string, queryText: string, description?: string,
  //         threshold?: number, cooldownMinutes?: number,
  //         deliveryChannel?: 'pushover' | 'slack' | 'both' }
  // -----------------------------------------------------------------------
  app.post('/api/v1/triggers', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { name, queryText, description, threshold, cooldownMinutes, deliveryChannel } = body as {
      name?: string
      queryText?: string
      description?: string
      threshold?: number
      cooldownMinutes?: number
      deliveryChannel?: 'pushover' | 'slack' | 'both'
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return c.json({ error: 'name is required', code: 'VALIDATION_ERROR' }, 400)
    }

    if (!queryText || typeof queryText !== 'string' || queryText.trim().length === 0) {
      return c.json({ error: 'queryText is required', code: 'VALIDATION_ERROR' }, 400)
    }

    logger.info({ name, queryText }, '[triggers-api] creating trigger')

    const trigger = await triggerService.create({
      name: name.trim(),
      queryText: queryText.trim(),
      description: typeof description === 'string' ? description.trim() : undefined,
      threshold: typeof threshold === 'number' ? threshold : undefined,
      cooldownMinutes: typeof cooldownMinutes === 'number' ? cooldownMinutes : undefined,
      deliveryChannel,
    })

    logger.info({ triggerId: trigger.id, name: trigger.name }, '[triggers-api] trigger created')

    return c.json({ trigger }, 201)
  })

  // -----------------------------------------------------------------------
  // DELETE /api/v1/triggers/:id
  // Soft-deactivates a trigger (sets enabled = false). Accepts name or UUID.
  // -----------------------------------------------------------------------
  app.delete('/api/v1/triggers/:id', async (c) => {
    const id = c.req.param('id')

    logger.info({ id }, '[triggers-api] deactivating trigger')

    await triggerService.delete(id)

    logger.info({ id }, '[triggers-api] trigger deactivated')

    return c.json({ message: `Trigger '${id}' deactivated` })
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/triggers/test
  // Tests a query against existing captures — returns top matches without firing.
  // Body: { queryText: string, limit?: number }
  // -----------------------------------------------------------------------
  app.post('/api/v1/triggers/test', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { queryText, limit } = body as { queryText?: string; limit?: number }

    if (!queryText || typeof queryText !== 'string' || queryText.trim().length === 0) {
      return c.json({ error: 'queryText is required', code: 'VALIDATION_ERROR' }, 400)
    }

    const maxLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 20) : 5

    logger.info({ queryText, limit: maxLimit }, '[triggers-api] testing trigger query')

    const matches = await triggerService.test(queryText.trim(), maxLimit)

    return c.json({ query: queryText, matches })
  })
}
