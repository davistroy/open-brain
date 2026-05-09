/**
 * TanStack Query hooks — captures domain (Phase G.1).
 *
 * Wraps `capturesApi` with standard query/mutation hooks so components
 * avoid duplicating queryKey strings or inline queryFn lambdas.
 *
 * Query key hierarchy:
 *   ['captures', 'list', params?]  — paginated list
 *   ['captures', 'detail', id]     — single capture
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { capturesApi } from './captures'
import type { CapturesListParams, CreateCapturePayload } from './captures'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Paginated list of captures. Enabled immediately; pass params to filter. */
export function useCaptures(params: CapturesListParams = {}) {
  return useQuery({
    queryKey: ['captures', 'list', params],
    queryFn: () => capturesApi.list(params),
  })
}

/** Single capture by id. Skips fetch when id is falsy. */
export function useCapture(id: string) {
  return useQuery({
    queryKey: ['captures', 'detail', id],
    queryFn: () => capturesApi.get(id),
    enabled: Boolean(id),
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a new capture.
 * On success invalidates the list so any rendered list re-fetches.
 */
export function useCreateCapture() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateCapturePayload) => capturesApi.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['captures', 'list'] })
    },
  })
}
