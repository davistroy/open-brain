/**
 * TanStack Query hooks — wiki domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['wiki', 'pages', params?]          — list of all wiki page metadata
 *   ['wiki', 'page', slug]              — single page with content
 *   ['wiki', 'recent-changes', limit?]  — recent git log entries
 *   ['wiki', 'lint-report']             — structured lint results
 *   ['wiki', 'stats']                   — aggregate wiki statistics
 *   ['wiki', 'search', q]               — search results
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { wikiApi } from './wiki'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List all wiki pages with optional type/tag filters. */
export function useWikiPages(params: { type?: string; tag?: string } = {}) {
  return useQuery({
    queryKey: ['wiki', 'pages', params],
    queryFn: () => wikiApi.pages(params),
    staleTime: 60_000,
  })
}

/** Full wiki page (metadata + markdown content). Skips fetch when slug is falsy. */
export function useWikiPage(slug: string) {
  return useQuery({
    queryKey: ['wiki', 'page', slug],
    queryFn: () => wikiApi.page(slug),
    enabled: Boolean(slug),
    staleTime: 60_000,
  })
}

/** Recent wiki git log entries. */
export function useWikiRecentChanges(limit = 20) {
  return useQuery({
    queryKey: ['wiki', 'recent-changes', limit],
    queryFn: () => wikiApi.recentChanges(limit),
    staleTime: 60_000,
  })
}

/** Structured lint report. `staleTime: 60_000` — lint runs are infrequent. */
export function useWikiLintReport() {
  return useQuery({
    queryKey: ['wiki', 'lint-report'],
    queryFn: () => wikiApi.lintReport(),
    staleTime: 60_000,
  })
}

/**
 * Aggregate wiki statistics.
 * WikiSection uses `['wiki', 'stats']` — keep this query key stable.
 */
export function useWikiStats() {
  return useQuery({
    queryKey: ['wiki', 'stats'],
    queryFn: () => wikiApi.stats(),
    staleTime: 60_000,
  })
}

/** Wiki content search. Skips fetch when q is blank. */
export function useWikiSearch(q: string) {
  return useQuery({
    queryKey: ['wiki', 'search', q],
    queryFn: () => wikiApi.search(q),
    enabled: Boolean(q?.trim()),
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Trigger a manual wiki lint job. Invalidates lint-report on success. */
export function useTriggerWikiLint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => wikiApi.triggerLint(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wiki', 'lint-report'] })
    },
  })
}

/** Trigger re-synthesis for a specific wiki page. Invalidates the page cache. */
export function useTriggerWikiResynthesize() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (page_path: string) => wikiApi.triggerResynthesize(page_path),
    onSuccess: (_data, page_path) => {
      // Invalidate the specific page — slug may differ from path, invalidate all pages
      qc.invalidateQueries({ queryKey: ['wiki', 'pages'] })
      qc.invalidateQueries({ queryKey: ['wiki', 'page'] })
      qc.invalidateQueries({ queryKey: ['wiki', 'stats'] })
      void page_path // suppress unused-var lint
    },
  })
}
