import type { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { BriefsService } from '../services/briefs.js'
import { NotFoundError } from '@open-brain/shared'
import { BriefKindSchema } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Query / body schemas
// ---------------------------------------------------------------------------

const listBriefsSchema = z.object({
  kind: BriefKindSchema.optional(),
  unread: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = parseInt(v ?? '20', 10)
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 20
    }),
  offset: z
    .string()
    .optional()
    .transform((v) => {
      const n = parseInt(v ?? '0', 10)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }),
})

const refineBriefSchema = z.object({
  option: z.string().min(1).max(200),
})

const patchBriefSchema = z.object({
  read: z.boolean(),
})

// ---------------------------------------------------------------------------

/**
 * Register briefs API routes.
 *
 * GET  /api/v1/briefs             — list with kind/unread filters + pagination
 * GET  /api/v1/briefs/:id         — full detail (body_html, toc, sources)
 * POST /api/v1/briefs/:id/refine  — async refinement (202); strict rate-limit applied in app.ts
 * POST /api/v1/briefs/:id/dismiss — set dismissed_at; 204
 * PATCH /api/v1/briefs/:id        — read/unread toggle
 */
export function registerBriefRoutes(app: Hono, briefsService: BriefsService): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/briefs
  // -------------------------------------------------------------------------
  app.get('/api/v1/briefs', zValidator('query', listBriefsSchema), async (c) => {
    const query = c.req.valid('query')

    const result = await briefsService.list({
      kind: query.kind,
      unread: query.unread || undefined,
      limit: query.limit,
      offset: query.offset,
    })

    return c.json(result)
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/briefs/:id
  // -------------------------------------------------------------------------
  app.get('/api/v1/briefs/:id', async (c) => {
    const id = c.req.param('id')

    try {
      const brief = await briefsService.getById(id)
      return c.json({ brief })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/refine  — async; 202 Accepted
  // Strict rate-limit is applied in app.ts BEFORE the default /api/v1/* limiter.
  // -------------------------------------------------------------------------
  app.post('/api/v1/briefs/:id/refine', zValidator('json', refineBriefSchema), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')

    try {
      const result = await briefsService.refine(id, body.option)
      return c.json(result, 202)
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/dismiss  — 204 No Content
  // -------------------------------------------------------------------------
  app.post('/api/v1/briefs/:id/dismiss', async (c) => {
    const id = c.req.param('id')

    try {
      await briefsService.dismiss(id)
      return c.body(null, 204)
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // PATCH /api/v1/briefs/:id  — read/unread toggle
  // -------------------------------------------------------------------------
  app.patch('/api/v1/briefs/:id', zValidator('json', patchBriefSchema), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')

    try {
      const brief = await briefsService.patchRead(id, body.read)
      return c.json({ brief })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })
}
