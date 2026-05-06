/**
 * Entity-domain API client — extracted from `lib/api-client.ts`.
 * All entity-related endpoints: list, get, captures, merge, related,
 * mentions-timeline, ask, and brief.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request, buildQueryString } from './core'
import type { ListEnvelope } from './core'
import type { Entity, EntityDetail, EntityType, RelatedEntity, Capture } from '../types'
import type { MentionsTimelineResponse, AskEntityResponse } from '../types'

// ---------------------------------------------------------------------------
// EntitiesListParams
// ---------------------------------------------------------------------------

export interface EntitiesListParams {
  limit?: number
  offset?: number
  entity_type?: EntityType
  sort_by?: 'mention_count' | 'last_seen' | 'name'
}

// ---------------------------------------------------------------------------
// entitiesApi
// ---------------------------------------------------------------------------

export const entitiesApi = {
  /** GET /api/v1/entities — paginated list */
  list: (params: EntitiesListParams = {}): Promise<ListEnvelope<Entity>> => {
    // Remap entity_type → type_filter to match the core-api query param name.
    const { entity_type, ...rest } = params
    const apiParams = { ...rest, ...(entity_type !== undefined ? { type_filter: entity_type } : {}) }
    const qs = buildQueryString(apiParams)
    return request<ListEnvelope<Entity>>(`/entities${qs}`)
  },

  /** GET /api/v1/entities/:id — full entity detail with captures + related entities */
  get: (id: string): Promise<EntityDetail> => {
    return request<EntityDetail>(`/entities/${encodeURIComponent(id)}`)
  },

  /** GET /api/v1/entities/:id/captures — captures linked to this entity */
  captures: (id: string, params: { limit?: number; offset?: number } = {}): Promise<ListEnvelope<Capture>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<Capture>>(`/entities/${encodeURIComponent(id)}/captures${qs}`)
  },

  /** POST /api/v1/entities/:id/merge — merge source entity into target */
  merge: (sourceId: string, targetId: string): Promise<{ message: string; source_id: string; target_id: string }> => {
    return request<{ message: string; source_id: string; target_id: string }>(
      `/entities/${encodeURIComponent(sourceId)}/merge`,
      { method: 'POST', body: JSON.stringify({ target_id: targetId }) },
    )
  },

  /** GET /api/v1/entities/:id/related — entities co-mentioned with this entity.
   *  API returns { related: [{id, name, type, shared_count}] }; we normalise
   *  the `type` → `entity_type` rename and wrap in the { items, total } envelope
   *  the page expects. */
  related: async (id: string, params: { limit?: number } = {}): Promise<{ items: RelatedEntity[]; total: number }> => {
    const qs = buildQueryString(params)
    const raw = await request<{ related: Array<{ id: string; name: string; type: string; shared_count: number }> }>(
      `/entities/${encodeURIComponent(id)}/related${qs}`,
    )
    const items = (raw.related ?? []).map(r => ({
      id: r.id,
      name: r.name,
      entity_type: r.type as EntityType,
      shared_count: r.shared_count,
    }))
    return { items, total: items.length }
  },

  /** GET /api/v1/entities/:id/mentions-timeline — mention counts bucketed over time */
  mentionsTimeline: (
    id: string,
    params: { window?: string; bucket?: string } = {},
  ): Promise<MentionsTimelineResponse> => {
    const qs = buildQueryString(params)
    return request<MentionsTimelineResponse>(
      `/entities/${encodeURIComponent(id)}/mentions-timeline${qs}`,
    )
  },

  /** POST /api/v1/entities/:id/ask — LLM synthesis answering a question about this entity */
  ask: (id: string, question: string): Promise<AskEntityResponse> => {
    return request<AskEntityResponse>(
      `/entities/${encodeURIComponent(id)}/ask`,
      { method: 'POST', body: JSON.stringify({ question }) },
    )
  },

  /** POST /api/v1/entities/:id/brief — enqueue entity-brief skill; returns 202 with job_id */
  brief: (id: string): Promise<{ job_id: string }> => {
    return request<{ job_id: string }>(
      `/entities/${encodeURIComponent(id)}/brief`,
      { method: 'POST' },
    )
  },
}
