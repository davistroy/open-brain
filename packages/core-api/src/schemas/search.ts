import { z } from 'zod'

const SEARCH_MODES = ['hybrid', 'vector', 'fts'] as const

/**
 * POST /api/v1/search request body schema.
 * Covers all search parameters per TDD §3.2 and PRD F01.
 */
export const searchSchema = z.object({
  query: z.string().min(1, 'Query string is required'),
  limit: z.number().int().min(1).max(50).default(10),
  offset: z.number().int().min(0).default(0),
  threshold: z.number().min(0).max(1).default(0.5),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  brain_views: z.array(z.string()).optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  temporal_weight: z.number().min(0).max(1).default(0.0),
  search_mode: z.enum(SEARCH_MODES).default('hybrid'),
  fts_weight: z.number().min(0).max(1).default(0.5),
  vector_weight: z.number().min(0).max(1).default(0.5),
})

export type SearchInput = z.infer<typeof searchSchema>
