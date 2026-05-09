/**
 * TanStack Query hooks — entities domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['entities', 'list', params?]                  — paginated entity list
 *   ['entities', 'detail', id]                     — full entity detail
 *   ['entities', 'captures', id, params?]          — captures linked to entity
 *   ['entities', 'related', id, params?]           — co-mentioned entities
 *   ['entities', 'mentions-timeline', id, params?] — mention count over time
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { entitiesApi } from './entities'
import type { EntitiesListParams } from './entities'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Paginated entity list. */
export function useEntities(params: EntitiesListParams = {}) {
  return useQuery({
    queryKey: ['entities', 'list', params],
    queryFn: () => entitiesApi.list(params),
  })
}

/** Full entity detail. Skips fetch when id is falsy. */
export function useEntity(id: string) {
  return useQuery({
    queryKey: ['entities', 'detail', id],
    queryFn: () => entitiesApi.get(id),
    enabled: Boolean(id),
  })
}

/** Captures linked to an entity. Skips fetch when id is falsy. */
export function useEntityCaptures(
  id: string,
  params: { limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: ['entities', 'captures', id, params],
    queryFn: () => entitiesApi.captures(id, params),
    enabled: Boolean(id),
  })
}

/** Entities co-mentioned with the given entity. Skips fetch when id is falsy. */
export function useEntityRelated(id: string, params: { limit?: number } = {}) {
  return useQuery({
    queryKey: ['entities', 'related', id, params],
    queryFn: () => entitiesApi.related(id, params),
    enabled: Boolean(id),
  })
}

/** Mention-count time-series for an entity. Skips fetch when id is falsy. */
export function useEntityMentionsTimeline(
  id: string,
  params: { window?: string; bucket?: string } = {},
) {
  return useQuery({
    queryKey: ['entities', 'mentions-timeline', id, params],
    queryFn: () => entitiesApi.mentionsTimeline(id, params),
    enabled: Boolean(id),
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Merge one entity into another.
 * On success, invalidates the entity list and the detail for both entities.
 */
export function useMergeEntity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
      entitiesApi.merge(sourceId, targetId),
    onSuccess: (_data, { sourceId, targetId }) => {
      qc.invalidateQueries({ queryKey: ['entities', 'list'] })
      qc.invalidateQueries({ queryKey: ['entities', 'detail', sourceId] })
      qc.invalidateQueries({ queryKey: ['entities', 'detail', targetId] })
    },
  })
}

/**
 * Ask an LLM question about a specific entity.
 * No cache invalidation — responses are one-shot synthesis, not stored state.
 */
export function useAskEntity() {
  return useMutation({
    mutationFn: ({ id, question }: { id: string; question: string }) =>
      entitiesApi.ask(id, question),
  })
}

/**
 * Enqueue entity-brief generation.
 * Returns `{ job_id }` — result arrives async via SSE / polling.
 * Invalidates the briefs list so the new brief appears when ready.
 */
export function useGenerateEntityBrief() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => entitiesApi.brief(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['briefs', 'list'] })
    },
  })
}
