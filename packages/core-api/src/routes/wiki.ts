/**
 * Wiki API routes.
 *
 * GET  /api/v1/wiki/pages             — list pages with optional type/tag filter
 * GET  /api/v1/wiki/pages/*path       — get specific page content
 * GET  /api/v1/wiki/recent-changes    — git log
 * GET  /api/v1/wiki/lint-report       — latest lint results
 * GET  /api/v1/wiki/search?q=query    — search across wiki pages
 * POST /api/v1/wiki/ingest            — trigger manual ingest {captureId}
 * POST /api/v1/wiki/lint              — trigger manual lint
 * POST /api/v1/wiki/resynthesize      — trigger re-synthesis for a wiki page {page_path}
 */

import type { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { WikiService } from '../services/wiki.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listPagesQuerySchema = z.object({
  type: z.string().optional(),
  tag: z.string().optional(),
})

const recentChangesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

const searchQuerySchema = z.object({
  q: z.string().min(1, 'Query string is required'),
})

const ingestBodySchema = z.object({
  captureId: z.string().uuid('captureId must be a valid UUID'),
})

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerWikiRoutes(app: Hono, wikiService: WikiService): void {
  // GET /api/v1/wiki/pages — list pages with optional type/tag filters
  app.get('/api/v1/wiki/pages', zValidator('query', listPagesQuerySchema), async (c) => {
    const { type, tag } = c.req.valid('query')
    const pages = await wikiService.listPages(type, tag)
    return c.json({ pages, total: pages.length })
  })

  // GET /api/v1/wiki/search?q=query — search across wiki page content
  app.get('/api/v1/wiki/search', zValidator('query', searchQuerySchema), async (c) => {
    const { q } = c.req.valid('query')
    const results = await wikiService.search(q)
    return c.json({ query: q, results, total: results.length })
  })

  // GET /api/v1/wiki/recent-changes — git log
  app.get('/api/v1/wiki/recent-changes', zValidator('query', recentChangesQuerySchema), async (c) => {
    const { limit } = c.req.valid('query')
    const changes = await wikiService.getRecentChanges(limit)
    return c.json({ changes, total: changes.length })
  })

  // GET /api/v1/wiki/lint-report — latest lint results
  app.get('/api/v1/wiki/lint-report', async (c) => {
    const report = await wikiService.getLintReport()
    if (report === null) {
      return c.json({ report: null, message: 'No lint report found' })
    }
    return c.json({ report })
  })

  // POST /api/v1/wiki/ingest — trigger manual ingest
  app.post('/api/v1/wiki/ingest', zValidator('json', ingestBodySchema), async (c) => {
    const { captureId } = c.req.valid('json')
    const jobId = await wikiService.triggerIngest(captureId)
    if (jobId === null) {
      return c.json({ error: 'Wiki ingest queue not configured' }, 503)
    }
    return c.json({ jobId, captureId, status: 'enqueued' }, 202)
  })

  // POST /api/v1/wiki/lint — trigger manual lint
  app.post('/api/v1/wiki/lint', async (c) => {
    const jobId = await wikiService.triggerLint()
    if (jobId === null) {
      return c.json({ error: 'Wiki lint queue not configured' }, 503)
    }
    return c.json({ jobId, status: 'enqueued' }, 202)
  })

  // POST /api/v1/wiki/resynthesize — trigger re-synthesis for a specific wiki page
  app.post('/api/v1/wiki/resynthesize', zValidator('json', z.object({ page_path: z.string() })), async (c) => {
    const { page_path } = c.req.valid('json')
    // Re-synthesis works by triggering a wiki-ingest job for the page
    // The wiki-ingest worker handles both initial creation and updates
    const jobId = await wikiService.triggerResynthesize(page_path)
    if (jobId === null) {
      return c.json({ error: 'Wiki resynthesize queue not configured' }, 503)
    }
    return c.json({ jobId, pagePath: page_path, status: 'enqueued' }, 202)
  })

  // GET /api/v1/wiki/pages/* — get specific page content (must be LAST to avoid catching other routes)
  app.get('/api/v1/wiki/pages/:path{.+}', async (c) => {
    const pagePath = c.req.param('path')
    const page = await wikiService.getPage(pagePath)
    if (!page) {
      return c.json({ error: `Wiki page not found: ${pagePath}` }, 404)
    }
    return c.json(page)
  })
}
