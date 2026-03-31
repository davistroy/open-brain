import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger, app_settings } from '@open-brain/shared'

/**
 * Register settings API routes.
 *
 * GET  /api/v1/settings/:key — retrieve a setting by key
 * PUT  /api/v1/settings/:key — upsert a setting
 */
export function registerSettingsRoutes(app: Hono, db: Database): void {
  app.get('/api/v1/settings/:key', async (c) => {
    const key = c.req.param('key')
    const rows = await db.select().from(app_settings).where(eq(app_settings.key, key))
    if (rows.length === 0) {
      return c.json({ error: 'Not found', key }, 404)
    }
    return c.json({ key: rows[0].key, value: rows[0].value, updated_at: rows[0].updated_at })
  })

  app.put('/api/v1/settings/:key', async (c) => {
    const key = c.req.param('key')
    let body: { value: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (body.value === undefined) {
      return c.json({ error: 'value is required' }, 400)
    }

    const now = new Date()
    await db.insert(app_settings).values({ key, value: body.value, updated_at: now })
      .onConflictDoUpdate({ target: app_settings.key, set: { value: body.value, updated_at: now } })

    logger.info({ key }, '[settings] Setting updated')
    return c.json({ key, value: body.value, updated_at: now.toISOString() })
  })
}
