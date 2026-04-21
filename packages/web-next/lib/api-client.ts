/**
 * API client for Open Brain web-next package.
 *
 * Design constraints (see M2 plan, work item 2.1 + decisions D108/D109):
 * - Namespaced function objects (not a class) — tree-shakes cleanly, no `this` binding.
 * - `X-Open-Brain-Caller: web-ui` on every request — CLAUDE.md silent-429 prevention.
 * - Throws `HttpError` on non-2xx — discriminable in error.tsx and inline error states.
 * - NO retry logic — TanStack Query v5 handles retry (default 3x via `retry` option).
 * - NO response shape normalization — handled per-screen to keep this layer minimal.
 */

// ---------------------------------------------------------------------------
// HttpError — thrown for all non-2xx responses
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number
  readonly body: unknown
  readonly path: string

  constructor(status: number, body: unknown, path: string) {
    super(`HTTP ${status} on ${path}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// Core request wrapper
// ---------------------------------------------------------------------------

const API_BASE = '/api/v1'

/**
 * Low-level fetch wrapper. Prefixes `/api/v1`, injects `X-Open-Brain-Caller: web-ui`,
 * sets `Content-Type: application/json` when a body is present, and throws
 * `HttpError` on non-2xx responses.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`

  const headers: Record<string, string> = {
    'X-Open-Brain-Caller': 'web-ui',
    // Spread any caller-supplied headers so they can override defaults if needed.
    ...(init.headers as Record<string, string> | undefined),
  }

  // Only set Content-Type for requests that carry a body.
  if (init.body !== undefined && init.body !== null) {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }
  }

  const response = await fetch(url, { ...init, headers })

  if (!response.ok) {
    let body: unknown
    const contentType = response.headers.get('content-type') ?? ''
    try {
      body = contentType.includes('application/json')
        ? await response.json()
        : await response.text()
    } catch {
      body = null
    }
    throw new HttpError(response.status, body, path)
  }

  // 204 No Content — return undefined cast to T (callers should type as void)
  if (response.status === 204) {
    return undefined as unknown as T
  }

  return response.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Query string builder
// ---------------------------------------------------------------------------

/**
 * Build a `?key=value` query string. Skips `undefined` values. Arrays are
 * serialized by repeating the key: `tags=a&tags=b`.
 */
export function buildQueryString(params: object): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          qs.append(key, String(item))
        }
      }
    } else {
      qs.set(key, String(value))
    }
  }
  const str = qs.toString()
  return str ? `?${str}` : ''
}

// ---------------------------------------------------------------------------
// Type imports from the local types file (never from @open-brain/shared)
// ---------------------------------------------------------------------------

import type {
  Capture,
  CaptureType,
  CaptureSource,
  BrainView,
  Entity,
  EntityDetail,
  EntityType,
  Brief,
  BriefDetail,
  SearchResult,
  DashboardStats,
} from './types'

// ---------------------------------------------------------------------------
// Re-exported union types — callers can import from here as a convenience
// ---------------------------------------------------------------------------

export type { Capture, CaptureType, CaptureSource, BrainView, Entity, EntityDetail, EntityType, Brief, BriefDetail, SearchResult, DashboardStats }

// ---------------------------------------------------------------------------
// Response envelope shapes (API-level, not UI-level)
// ---------------------------------------------------------------------------

/** Generic paginated list envelope returned by most list endpoints. */
export interface ListEnvelope<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

// ---------------------------------------------------------------------------
// capturesApi
// ---------------------------------------------------------------------------

export interface CapturesListParams {
  limit?: number
  offset?: number
  brain_view?: BrainView
  capture_type?: CaptureType
  source?: CaptureSource
  pipeline_status?: string
}

export interface CreateCapturePayload {
  content: string
  capture_type: CaptureType
  brain_view: BrainView
  source?: CaptureSource
}

export const capturesApi = {
  /** GET /api/v1/captures — paginated list */
  list: (params: CapturesListParams = {}): Promise<ListEnvelope<Capture>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<Capture>>(`/captures${qs}`)
  },

  /** GET /api/v1/captures/:id — single capture */
  get: (id: string): Promise<Capture> => {
    return request<Capture>(`/captures/${encodeURIComponent(id)}`)
  },

  /** POST /api/v1/captures — create a new capture */
  create: (payload: CreateCapturePayload): Promise<{ id: string; pipeline_status: string; created_at: string }> => {
    return request<{ id: string; pipeline_status: string; created_at: string }>('/captures', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
}

// ---------------------------------------------------------------------------
// entitiesApi
// ---------------------------------------------------------------------------

export interface EntitiesListParams {
  limit?: number
  offset?: number
  entity_type?: EntityType
  sort_by?: 'mention_count' | 'last_seen' | 'name'
}

export const entitiesApi = {
  /** GET /api/v1/entities — paginated list */
  list: (params: EntitiesListParams = {}): Promise<ListEnvelope<Entity>> => {
    const qs = buildQueryString(params)
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
}

// ---------------------------------------------------------------------------
// briefsApi — M2 introduces the briefs table (migration 0030)
// ---------------------------------------------------------------------------

export interface BriefsListParams {
  limit?: number
  offset?: number
  kind?: string
}

export const briefsApi = {
  /** GET /api/v1/briefs — paginated list */
  list: (params: BriefsListParams = {}): Promise<ListEnvelope<Brief>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<Brief>>(`/briefs${qs}`)
  },

  /** GET /api/v1/briefs/:id — full brief with body_html + TOC + sources */
  get: (id: string): Promise<BriefDetail> => {
    return request<BriefDetail>(`/briefs/${encodeURIComponent(id)}`)
  },

  /** POST /api/v1/briefs/:id/refine — async refinement; response arrives via SSE */
  refine: (id: string, instruction: string): Promise<{ job_id: string }> => {
    return request<{ job_id: string }>(`/briefs/${encodeURIComponent(id)}/refine`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    })
  },
}

// ---------------------------------------------------------------------------
// statsApi
// ---------------------------------------------------------------------------

/** Raw stats envelope from GET /api/v1/stats */
export interface StatsResponse {
  total_captures: number
  by_type: Record<string, number>
  by_view: Record<string, number>
  by_source: Record<string, number>
  pipeline_health: {
    pending: number
    processing: number
    complete: number
    failed: number
  }
}

export const statsApi = {
  /** GET /api/v1/stats — aggregate capture statistics */
  get: (): Promise<StatsResponse> => {
    return request<StatsResponse>('/stats')
  },
}

// ---------------------------------------------------------------------------
// searchApi
// ---------------------------------------------------------------------------

export interface SearchParams {
  q: string
  limit?: number
  offset?: number
  brain_view?: BrainView
  hybrid?: boolean
  include_related?: boolean
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
  query: string
}

export const searchApi = {
  /** GET /api/v1/search — hybrid FTS + vector search */
  search: (params: SearchParams): Promise<SearchResponse> => {
    const qs = buildQueryString(params)
    return request<SearchResponse>(`/search${qs}`)
  },
}

// ---------------------------------------------------------------------------
// synthesizeApi
// ---------------------------------------------------------------------------

export interface SynthesizePayload {
  query: string
  limit?: number
}

export interface SynthesizeResponse {
  answer: string
  sources: Array<{ id: string; score: number }>
  query: string
}

export const synthesizeApi = {
  /** POST /api/v1/synthesize — LLM synthesis over matching captures */
  query: (payload: SynthesizePayload): Promise<SynthesizeResponse> => {
    return request<SynthesizeResponse>('/synthesize', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
}

// ---------------------------------------------------------------------------
// intelligenceApi
// ---------------------------------------------------------------------------

export interface IntelligenceEntry {
  id: string
  skill_name: string
  capture_id: string | null
  input_summary: string | null
  output_summary: string | null
  result: Record<string, unknown> | null
  duration_ms: number | null
  created_at: string
}

export interface IntelligenceSummaryResponse {
  connections: IntelligenceEntry | null
  drift: IntelligenceEntry | null
}

export const intelligenceApi = {
  /** GET /api/v1/intelligence/summary — latest connections + drift results */
  summary: (): Promise<IntelligenceSummaryResponse> => {
    return request<IntelligenceSummaryResponse>('/intelligence/summary')
  },

  /** GET /api/v1/intelligence/connections/latest */
  connectionsLatest: (): Promise<{ data: IntelligenceEntry | null }> => {
    return request<{ data: IntelligenceEntry | null }>('/intelligence/connections/latest')
  },

  /** GET /api/v1/intelligence/drift/latest */
  driftLatest: (): Promise<{ data: IntelligenceEntry | null }> => {
    return request<{ data: IntelligenceEntry | null }>('/intelligence/drift/latest')
  },

  /** GET /api/v1/intelligence/unresolved-questions */
  unresolvedQuestions: (limit = 5): Promise<{ questions: Array<{ id: string; content: string; brain_view: string; created_at: string }>; count: number }> => {
    const qs = buildQueryString({ limit })
    return request<{ questions: Array<{ id: string; content: string; brain_view: string; created_at: string }>; count: number }>(
      `/intelligence/unresolved-questions${qs}`,
    )
  },

  /** POST /api/v1/intelligence/:skill/trigger — manually trigger an intelligence skill */
  trigger: (
    skill: 'daily-connections' | 'drift-monitor' | 'daily-sweep-skill',
    overrides: Record<string, unknown> = {},
  ): Promise<{ skill: string; job_id: string; status: string; message: string }> => {
    return request<{ skill: string; job_id: string; status: string; message: string }>(
      `/intelligence/${skill}/trigger`,
      { method: 'POST', body: JSON.stringify(overrides) },
    )
  },
}
