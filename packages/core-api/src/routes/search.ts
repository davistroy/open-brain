import type { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { SearchService } from '../services/search.js'

const searchQuerySchema = z.object({
  q: z.string().min(1, 'Query string is required'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  temporal_weight: z.coerce.number().min(0).max(1).default(0.0),
  fts_weight: z.coerce.number().min(0).max(1).default(0.5),
  vector_weight: z.coerce.number().min(0).max(1).default(0.5),
  brain_views: z
    .string()
    .transform(v => v.split(',').map(s => s.trim()).filter(Boolean))
    .optional(),
  capture_types: z
    .string()
    .transform(v => v.split(',').map(s => s.trim()).filter(Boolean))
    .optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
})

export function registerSearchRoutes(app: Hono, searchService: SearchService): void {
  // GET /api/v1/search?q=... — hybrid semantic + FTS search over captures
  app.get('/api/v1/search', zValidator('query', searchQuerySchema), async (c) => {
    const query = c.req.valid('query')

    const results = await searchService.search(query.q, {
      limit: query.limit,
      temporalWeight: query.temporal_weight,
      ftsWeight: query.fts_weight,
      vectorWeight: query.vector_weight,
      brainViews: query.brain_views,
      captureTypes: query.capture_types as string[] | undefined,
      dateFrom: query.date_from ? new Date(query.date_from) : undefined,
      dateTo: query.date_to ? new Date(query.date_to) : undefined,
    })

    return c.json({
      query: query.q,
      total: results.length,
      results,
    })
  })
}
