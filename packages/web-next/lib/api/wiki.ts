/**
 * API client — wiki domain.
 *
 * Covers wiki page listing, content, recent changes, lint report, stats,
 * search, and job triggers (lint + resynthesize).
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request, buildQueryString } from './core'

// ---------------------------------------------------------------------------
// wikiApi — wiki page listing, content, recent changes, lint, stats, search
//
// Endpoint map (see packages/core-api/src/routes/wiki.ts):
//   GET  /api/v1/wiki/pages              → { pages: WikiPageMeta[], total: number }
//   GET  /api/v1/wiki/pages/*path        → WikiPageFull (path + frontmatter fields + content)
//   GET  /api/v1/wiki/recent-changes     → { changes: WikiChange[], total: number }
//   GET  /api/v1/wiki/lint-report        → WikiLintReport (total_pages, issues[], last_run)
//   GET  /api/v1/wiki/stats              → WikiStats
//   GET  /api/v1/wiki/search?q=query     → { query, results, pages, total }
//   POST /api/v1/wiki/lint               → { jobId, status: 'enqueued' }
//   POST /api/v1/wiki/resynthesize       → { jobId, pagePath, status: 'enqueued' }
// ---------------------------------------------------------------------------

/** Flat wiki page metadata — returned by list and search endpoints. */
export interface WikiPageMeta {
  path: string
  title: string
  type: string
  created: string
  updated: string
  source_count?: number
  tags?: string[]
  aliases?: string[]
}

/** Full wiki page — metadata + raw markdown content. */
export interface WikiPageFull extends WikiPageMeta {
  content: string
}

/** Wiki search result — metadata + snippet. */
export interface WikiSearchResult extends WikiPageMeta {
  snippet: string
}

/** One entry in the recent-changes git log. */
export interface WikiChange {
  hash: string
  message: string
  author: string
  date: string
  files_changed: string[]
}

/** One lint issue entry from the lint report. */
export interface WikiLintIssue {
  path: string
  rule: string
  message: string
  severity: 'error' | 'warning' | 'info'
}

/** Structured lint report returned by GET /api/v1/wiki/lint-report. */
export interface WikiLintReport {
  total_pages: number
  issues: WikiLintIssue[]
  last_run: string | null
}

/** Aggregate wiki statistics returned by GET /api/v1/wiki/stats. */
export interface WikiStats {
  page_count: number
  orphan_count: number
  domain_distribution: Record<string, number>
  last_updated: string | null
  last_lint_run: string | null
}

export const wikiApi = {
  /** GET /api/v1/wiki/pages — list all wiki pages with optional type/tag filters. */
  pages: (params: { type?: string; tag?: string } = {}): Promise<{ pages: WikiPageMeta[]; total: number }> => {
    const qs = buildQueryString(params)
    return request<{ pages: WikiPageMeta[]; total: number }>(`/wiki/pages${qs}`)
  },

  /**
   * GET /api/v1/wiki/pages/*path — fetch a specific page by slug path.
   * `slug` is the dot-slash joined path segments, e.g. "career/goals" or just "home".
   * Returns WikiPageFull (metadata + raw markdown content).
   */
  page: (slug: string): Promise<WikiPageFull> => {
    // Encode each segment individually but preserve slashes as path separators.
    const encodedPath = slug.split('/').map(encodeURIComponent).join('/')
    return request<WikiPageFull>(`/wiki/pages/${encodedPath}`)
  },

  /** GET /api/v1/wiki/recent-changes — recent git log entries. */
  recentChanges: (limit = 20): Promise<{ changes: WikiChange[]; total: number }> => {
    const qs = buildQueryString({ limit })
    return request<{ changes: WikiChange[]; total: number }>(`/wiki/recent-changes${qs}`)
  },

  /** GET /api/v1/wiki/lint-report — structured lint results (or empty report). */
  lintReport: (): Promise<WikiLintReport> => {
    return request<WikiLintReport>('/wiki/lint-report')
  },

  /** GET /api/v1/wiki/stats — aggregate wiki statistics. */
  stats: (): Promise<WikiStats> => {
    return request<WikiStats>('/wiki/stats')
  },

  /** GET /api/v1/wiki/search?q=query — search across wiki page content. */
  search: (q: string): Promise<{ query: string; results: WikiSearchResult[]; pages: WikiSearchResult[]; total: number }> => {
    const qs = buildQueryString({ q })
    return request<{ query: string; results: WikiSearchResult[]; pages: WikiSearchResult[]; total: number }>(
      `/wiki/search${qs}`,
    )
  },

  /** POST /api/v1/wiki/lint — trigger manual lint job. */
  triggerLint: (): Promise<{ jobId: string; status: string }> => {
    return request<{ jobId: string; status: string }>('/wiki/lint', { method: 'POST' })
  },

  /** POST /api/v1/wiki/resynthesize — trigger re-synthesis for a specific page. */
  triggerResynthesize: (page_path: string): Promise<{ jobId: string; pagePath: string; status: string }> => {
    return request<{ jobId: string; pagePath: string; status: string }>('/wiki/resynthesize', {
      method: 'POST',
      body: JSON.stringify({ page_path }),
    })
  },
}
