/**
 * TanStack Query hooks — briefs domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['briefs', 'list', params?]  — paginated list
 *   ['briefs', 'detail', id]     — full brief with body_html, TOC, sources
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { briefsApi } from './briefs'
import type { BriefsListParams } from './briefs'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Paginated list of briefs. */
export function useBriefs(params: BriefsListParams = {}) {
  return useQuery({
    queryKey: ['briefs', 'list', params],
    queryFn: () => briefsApi.list(params),
  })
}

/**
 * Full brief detail including body_html, TOC, and sources.
 * Skips fetch when id is falsy.
 */
export function useBrief(id: string) {
  return useQuery({
    queryKey: ['briefs', 'detail', id],
    queryFn: () => briefsApi.get(id),
    enabled: Boolean(id),
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Mark a brief as read/unread. Invalidates the detail entry. */
export function usePatchBriefRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      briefsApi.patchRead(id, read),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['briefs', 'detail', id] })
      qc.invalidateQueries({ queryKey: ['briefs', 'list'] })
    },
  })
}

/** Soft-dismiss a brief without marking it read. Invalidates the list. */
export function useDismissBrief() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => briefsApi.dismiss(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['briefs', 'detail', id] })
      qc.invalidateQueries({ queryKey: ['briefs', 'list'] })
    },
  })
}

/**
 * Request async refinement of a brief.
 * Response arrives via SSE; this mutation only enqueues the job.
 * Invalidates the detail so any polling consumer picks up the update.
 */
export function useRefineBrief() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, instruction }: { id: string; instruction: string }) =>
      briefsApi.refine(id, instruction),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['briefs', 'detail', id] })
    },
  })
}
