/**
 * Wiki API routes.
 *
 * GET  /api/v1/wiki/pages             — list pages with optional type/tag filter
 * GET  /api/v1/wiki/pages/*path       — get specific page content (flat WikiPageFull shape)
 * GET  /api/v1/wiki/recent-changes    — git log
 * GET  /api/v1/wiki/lint-report       — latest lint results (structured WikiLintReport)
 * GET  /api/v1/wiki/search?q=query    — search across wiki pages (flat shape + pages alias)
 * GET  /api/v1/wiki/stats             — aggregate stats (page count, orphans, domains)
 * POST /api/v1/wiki/ingest            — trigger manual ingest {captureId}
 * POST /api/v1/wiki/lint              — trigger manual lint
 * POST /api/v1/wiki/resynthesize      — trigger re-synthesis for a wiki page {page_path}
 *
 * Response shape conventions:
 *   All page endpoints flatten WikiFrontmatter into the response object.
 *   WikiPageMeta: { path, title, type, created, updated, source_count?, tags?, aliases? }
 *   WikiPageFull: WikiPageMeta + { content }
 */

import type { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { WikiService, WikiPageSummary, WikiSearchResult } from '../services/wiki.js'
import type { WikiFrontmatter } from '@open-brain/shared'
import { ConfigError, NotFoundError } from '@open-brain/shared'

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
// Response shaping helpers
// ---------------------------------------------------------------------------

/** Flatten WikiFrontmatter + path into the flat WikiPageMeta shape the web client expects. */
function flattenPageMeta(path: string, fm: WikiFrontmatter) {
  return {
    path,
    title: fm.title,
    type: fm.type,
    created: fm.created,
    updated: fm.updated,
    source_count: fm.source_count,
    tags: fm.tags,
    aliases: fm.aliases,
  }
}

function flattenSummary(s: WikiPageSummary) {
  return flattenPageMeta(s.path, s.frontmatter)
}

function flattenSearchResult(r: WikiSearchResult) {
  return {
    ...flattenPageMeta(r.path, r.frontmatter),
    snippet: r.snippet,
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerWikiRoutes(app: Hono, wikiService: WikiService): void {
  // GET /api/v1/wiki/pages — list pages with optional type/tag filters
  app.get('/api/v1/wiki/pages', zValidator('query', listPagesQuerySchema), async (c) => {
    const { type, tag } = c.req.valid('query')
    const pages = await wikiService.listPages(type, tag)
    const flat = pages.map(flattenSummary)
    return c.json({ pages: flat, total: flat.length })
  })

  // GET /api/v1/wiki/search?q=query — search across wiki page content
  // Returns { query, results, pages, total } — "pages" alias for web-client compat
  app.get('/api/v1/wiki/search', zValidator('query', searchQuerySchema), async (c) => {
    const { q } = c.req.valid('query')
    const results = await wikiService.search(q)
    const flat = results.map(flattenSearchResult)
    return c.json({ query: q, results: flat, pages: flat, total: flat.length })
  })

  // GET /api/v1/wiki/recent-changes — git log
  app.get('/api/v1/wiki/recent-changes', zValidator('query', recentChangesQuerySchema), async (c) => {
    const { limit } = c.req.valid('query')
    const changes = await wikiService.getRecentChanges(limit)
    return c.json({ changes, total: changes.length })
  })

  // GET /api/v1/wiki/lint-report — structured lint results (or empty report)
  // Returns WikiLintReport directly (not wrapped in { report }) for web-client compat
  app.get('/api/v1/wiki/lint-report', async (c) => {
    const report = await wikiService.getLintReport()
    if (report === null) {
      return c.json({ total_pages: 0, issues: [], last_run: null })
    }
    return c.json(report)
  })

  // GET /api/v1/wiki/stats — aggregate wiki statistics
  app.get('/api/v1/wiki/stats', async (c) => {
    const stats = await wikiService.getStats()
    return c.json(stats)
  })

  // POST /api/v1/wiki/ingest — trigger manual ingest
  app.post('/api/v1/wiki/ingest', zValidator('json', ingestBodySchema), async (c) => {
    const { captureId } = c.req.valid('json')
    const jobId = await wikiService.triggerIngest(captureId)
    if (jobId === null) {
      throw new ConfigError('Wiki ingest queue not configured')
    }
    return c.json({ jobId, captureId, status: 'enqueued' }, 202)
  })

  // POST /api/v1/wiki/lint — trigger manual lint
  app.post('/api/v1/wiki/lint', async (c) => {
    const jobId = await wikiService.triggerLint()
    if (jobId === null) {
      throw new ConfigError('Wiki lint queue not configured')
    }
    return c.json({ jobId, status: 'enqueued' }, 202)
  })

  // POST /api/v1/wiki/resynthesize — trigger re-synthesis for a specific wiki page
  app.post('/api/v1/wiki/resynthesize', zValidator('json', z.object({ page_path: z.string() })), async (c) => {
    const { page_path } = c.req.valid('json')
    const jobId = await wikiService.triggerResynthesize(page_path)
    if (jobId === null) {
      throw new ConfigError('Wiki resynthesize queue not configured')
    }
    return c.json({ jobId, pagePath: page_path, status: 'enqueued' }, 202)
  })

  // GET /api/v1/wiki/pages/* — get specific page content (must be LAST to avoid catching other routes)
  app.get('/api/v1/wiki/pages/:path{.+}', async (c) => {
    const pagePath = c.req.param('path')
    const page = await wikiService.getPage(pagePath)
    if (!page) {
      throw new NotFoundError(`Wiki page not found: ${pagePath}`)
    }
    // Flatten frontmatter into response to match WikiPageFull client type
    return c.json({
      ...flattenPageMeta(page.path, page.frontmatter),
      content: page.content,
    })
  })
}
