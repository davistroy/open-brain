/**
 * Search API — hybrid FTS + vector search.
 * Imported by every `lib/api/<domain>.ts` file. Re-exports types from
 * `../types` for the public barrel so consumers can
 * `import { ... } from '@/lib/api-client'`.
 */

import { request, buildQueryString } from './core'
import type { BrainView, SearchResult } from './core'

// ---------------------------------------------------------------------------
// SearchParams
// ---------------------------------------------------------------------------

export interface SearchParams {
  q: string
  limit?: number
  offset?: number
  brain_view?: BrainView
  hybrid?: boolean
  include_related?: boolean
}

// ---------------------------------------------------------------------------
// SearchResponse
// ---------------------------------------------------------------------------

export interface SearchResponse {
  results: SearchResult[]
  total: number
  query: string
}

// ---------------------------------------------------------------------------
// searchApi
// ---------------------------------------------------------------------------

export const searchApi = {
  /** GET /api/v1/search — hybrid FTS + vector search */
  search: (params: SearchParams): Promise<SearchResponse> => {
    const qs = buildQueryString(params)
    return request<SearchResponse>(`/search${qs}`)
  },
}
