/**
 * TanStack Query hooks — search domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['search', query]   — hybrid search results (shared between SearchResults + EntityFacets)
 *
 * Note: EntityFacets re-uses the SAME query key as SearchResults so results
 * are served from cache without a duplicate network request. Keep the queryKey
 * shape stable — components depend on it for cache-sharing.
 */

import { useQuery } from '@tanstack/react-query'
import { searchApi } from './search'
import type { SearchParams } from './search'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Hybrid FTS + vector search.
 *
 * `staleTime: 30_000` matches the existing inline usage in SearchResults and
 * EntityFacets — results stay fresh for 30s without re-fetching on focus.
 *
 * Skips the fetch when the query string is blank.
 */
export function useSearch(params: SearchParams) {
  return useQuery({
    queryKey: ['search', params.q],
    queryFn: () => searchApi.search(params),
    enabled: Boolean(params.q?.trim()),
    staleTime: 30_000,
  })
}
