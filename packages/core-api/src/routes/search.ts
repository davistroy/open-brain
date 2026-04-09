import type { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { SearchService, SearchResponse } from '../services/search.js'
import { searchSchema } from '../schemas/search.js'

const csvToArray = z
  .string()
  .transform(v => v.split(',').map(s => s.trim()).filter(Boolean))
  .optional()

const searchQuerySchema = z.object({
  q: z.string().min(1, 'Query string is required'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  temporal_weight: z.coerce.number().min(0).max(1).default(0.1),
  fts_weight: z.coerce.number().min(0).max(1).default(0.5),
  vector_weight: z.coerce.number().min(0).max(1).default(0.5),
  search_mode: z.enum(['hybrid', 'vector', 'fts']).default('hybrid'),
  // Accept both singular and plural forms for convenience
  brain_views: csvToArray,
  brain_view: csvToArray,
  capture_types: csvToArray,
  capture_type: csvToArray,
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  include_related: z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1').default('false'),
}).transform(data => ({
  ...data,
  // Merge singular/plural: prefer plural if both provided
  brain_views: data.brain_views ?? data.brain_view,
  capture_types: data.capture_types ?? data.capture_type,
}))

export function registerSearchRoutes(app: Hono, searchService: SearchService): void {
  // GET /api/v1/search?q=... — hybrid semantic + FTS search over captures
  app.get('/api/v1/search', zValidator('query', searchQuerySchema), async (c) => {
    const query = c.req.valid('query')

    const searchOptions = {
      limit: query.limit,
      temporalWeight: query.temporal_weight,
      ftsWeight: query.fts_weight,
      vectorWeight: query.vector_weight,
      searchMode: query.search_mode as 'hybrid' | 'vector' | 'fts',
      brainViews: query.brain_views,
      captureTypes: query.capture_types as string[] | undefined,
      dateFrom: query.date_from ? new Date(query.date_from) : undefined,
      dateTo: query.date_to ? new Date(query.date_to) : undefined,
      includeRelated: query.include_related,
    }

    if (query.include_related) {
      const response: SearchResponse = await searchService.searchWithRelated(query.q, searchOptions)
      return c.json({
        query: query.q,
        total: response.results.length,
        results: response.results,
        ...(response.relatedResults ? { related_results: response.relatedResults } : {}),
      })
    }

    const results = await searchService.search(query.q, searchOptions)
    return c.json({
      query: query.q,
      total: results.length,
      results,
    })
  })

  // POST /api/v1/search — full-featured search with JSON body and pagination
  app.post('/api/v1/search', zValidator('json', searchSchema), async (c) => {
    const body = c.req.valid('json')

    const searchOptions = {
      limit: body.limit,
      temporalWeight: body.temporal_weight,
      ftsWeight: body.fts_weight,
      vectorWeight: body.vector_weight,
      searchMode: body.search_mode,
      brainViews: body.brain_views,
      captureTypes: undefined as string[] | undefined, // capture_type filter not in POST schema; extend SearchOptions if needed
      dateFrom: body.start_date ? new Date(body.start_date) : undefined,
      dateTo: body.end_date ? new Date(body.end_date) : undefined,
      includeRelated: body.include_related,
    }

    if (body.include_related) {
      const response: SearchResponse = await searchService.searchWithRelated(body.query, searchOptions)
      const paginated = response.results.slice(body.offset, body.offset + body.limit)
      return c.json({
        query: body.query,
        total: response.results.length,
        results: paginated,
        ...(response.relatedResults ? { related_results: response.relatedResults } : {}),
      })
    }

    const results = await searchService.search(body.query, searchOptions)

    // Apply client-side offset for pagination (hybrid_search returns ordered results)
    const paginated = results.slice(body.offset, body.offset + body.limit)

    return c.json({
      query: body.query,
      total: results.length,
      results: paginated,
    })
  })
}
