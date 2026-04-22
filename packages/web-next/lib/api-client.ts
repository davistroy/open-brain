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

function getApiBase(): string {
  if (typeof window !== 'undefined') return '/api/v1'
  const host = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002'
  return `${host.replace(/\/$/, '')}/api/v1`
}

/**
 * Low-level fetch wrapper. Prefixes `/api/v1`, injects `X-Open-Brain-Caller: web-ui`,
 * sets `Content-Type: application/json` when a body is present, and throws
 * `HttpError` on non-2xx responses.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${getApiBase()}${path}`

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
  MentionsTimelineResponse,
  AskEntityResponse,
  BoardCommitment,
  CommitmentStatus,
  Integration,
  IntegrationStatus,
  SettingEntry as SettingEntryType,
} from './types'

// ---------------------------------------------------------------------------
// Re-exported union types — callers can import from here as a convenience
// ---------------------------------------------------------------------------

export type { Capture, CaptureType, CaptureSource, BrainView, Entity, EntityDetail, EntityType, Brief, BriefDetail, SearchResult, DashboardStats, MentionsTimelineResponse, AskEntityResponse, BoardCommitment, CommitmentStatus, Integration, IntegrationStatus }

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
  /** Filter by `source_metadata.source_provider` — used by the Financial page provider tabs. */
  source_provider?: string
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

  /** GET /api/v1/entities/:id/related — entities co-mentioned with this entity */
  related: (id: string, params: { limit?: number } = {}): Promise<{ items: import('./types').RelatedEntity[]; total: number }> => {
    const qs = buildQueryString(params)
    return request<{ items: import('./types').RelatedEntity[]; total: number }>(
      `/entities/${encodeURIComponent(id)}/related${qs}`,
    )
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

  /** PATCH /api/v1/briefs/:id — update brief metadata (e.g. mark as read) */
  patchRead: (id: string, read: boolean): Promise<void> => {
    return request<void>(`/briefs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ read }),
    })
  },

  /** POST /api/v1/briefs/:id/dismiss — soft-dismiss without marking read */
  dismiss: (id: string): Promise<void> => {
    return request<void>(`/briefs/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    })
  },

  /** POST /api/v1/briefs/:id/refine — async refinement; response arrives via SSE */
  refine: (id: string, instruction: string): Promise<{ job_id: string }> => {
    return request<{ job_id: string }>(`/briefs/${encodeURIComponent(id)}/refine`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    })
  },

  /**
   * GET /api/v1/briefs/:id/audio — fetch TTS audio for a brief.
   * Returns a Blob (audio/mpeg). Bypasses the `request()` wrapper because we
   * need the raw Response for Blob extraction (not JSON).
   * Throws HttpError on non-2xx (same semantics as request()).
   */
  audio: async (id: string): Promise<Blob> => {
    const path = `/briefs/${encodeURIComponent(id)}/audio`
    const url = `${getApiBase()}${path}`
    const response = await fetch(url, {
      headers: { 'X-Open-Brain-Caller': 'web-ui' },
    })
    if (!response.ok) {
      let body: unknown
      try {
        body = await response.text()
      } catch {
        body = null
      }
      throw new HttpError(response.status, body, path)
    }
    return response.blob()
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

/**
 * Actual response shape from POST /api/v1/synthesize.
 * Route returns { response: string, capture_count: number } — NOT { answer, sources, query }.
 * See packages/core-api/src/routes/synthesize.ts c.json({response, capture_count}).
 */
export interface SynthesizeResponse {
  response: string
  capture_count: number
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

// ---------------------------------------------------------------------------
// skillsApi — generic skill trigger via POST /api/v1/skills/:name/trigger
// ---------------------------------------------------------------------------

export interface SkillTriggerResponse {
  skill: string
  job_id: string
  status: string
  message: string
}

export const skillsApi = {
  /**
   * POST /api/v1/skills/:name/trigger — manually trigger any skill by name.
   * Returns 202 with { skill, job_id, status: 'queued', message }.
   * Optional params are forwarded as the request body (skill overrides / input).
   */
  trigger: (
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<SkillTriggerResponse> => {
    return request<SkillTriggerResponse>(
      `/skills/${encodeURIComponent(name)}/trigger`,
      { method: 'POST', body: JSON.stringify(params) },
    )
  },
}

// ---------------------------------------------------------------------------
// commitmentsApi — Board Kanban (M3, screen 09)
// ---------------------------------------------------------------------------

export interface CommitmentsListParams {
  status?: CommitmentStatus
  entity_id?: string
  limit?: number
  offset?: number
}

export interface CreateCommitmentPayload {
  text: string
  entity_id?: string
  due_date?: string     // ISO date "YYYY-MM-DD"
  status?: CommitmentStatus
}

export interface PatchCommitmentPayload {
  resolved?: boolean
  status?: CommitmentStatus
  due_date?: string
}

export const commitmentsApi = {
  /** GET /api/v1/commitments — paginated list with optional status + entity_id filters */
  list: (params: CommitmentsListParams = {}): Promise<ListEnvelope<BoardCommitment>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<BoardCommitment>>(`/commitments${qs}`)
  },

  /** GET /api/v1/entities/:id/commitments — open commitments for a specific entity */
  forEntity: (entityId: string, params: { limit?: number } = {}): Promise<ListEnvelope<BoardCommitment>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<BoardCommitment>>(
      `/entities/${encodeURIComponent(entityId)}/commitments${qs}`,
    )
  },

  /** PATCH /api/v1/commitments/:id — toggle resolved or update status/due_date */
  patch: (id: string, body: PatchCommitmentPayload): Promise<BoardCommitment> => {
    return request<BoardCommitment>(
      `/commitments/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
  },

  /** POST /api/v1/commitments — manually create a commitment */
  create: (body: CreateCommitmentPayload): Promise<BoardCommitment> => {
    return request<BoardCommitment>('/commitments', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
}

// ---------------------------------------------------------------------------
// settingsApi — read/write app_settings via GET/PUT /api/v1/settings/:key
// ---------------------------------------------------------------------------

// Re-export SettingEntry from types for callers importing from api-client.
export type { SettingEntryType as SettingEntry };

export const settingsApi = {
  /**
   * GET /api/v1/settings/:key — read a single setting value.
   * Returns `{ key, value, updated_at }`. Throws HttpError 404 if key not set.
   */
  get: (key: string): Promise<SettingEntryType> => {
    return request<SettingEntryType>(`/settings/${encodeURIComponent(key)}`)
  },

  /**
   * PUT /api/v1/settings/:key — write a setting value.
   * Returns `{ key, value, updated_at }`.
   */
  put: (key: string, value: unknown): Promise<SettingEntryType> => {
    return request<SettingEntryType>(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  },
}

// ---------------------------------------------------------------------------
// investmentsApi — Schwab balance + positions data (M3, screen 5.4)
//
// There are no dedicated /investments API endpoints. Investment data lives
// as financial pipeline captures with source_provider='schwab'. This namespace
// fetches schwab captures and shapes them into normalized records for the
// HoldingsTable and AllocationChart client components.
//
// All heavy transformation (latestBalances, latestPositions, balanceHistory)
// is client-side (same as /web InvestmentsApi). The server RSC page fetches
// the raw captures via capturesApi.list; client components receive the raw
// capture list and do the shaping themselves so the RSC stays simple.
// ---------------------------------------------------------------------------

/** One balance snapshot, normalized from schwab_balance_snapshot metadata. */
export interface SchwabSnapshotRecord {
  capture_id: string
  created_at: string
  account_name: string
  account_mask: string
  as_of: string
  account_value: number
  cash_value: number
  market_value: number
  day_change: number
  day_change_pct: string
}

/** One holding row extracted from schwab_position_snapshot metadata. */
export interface SchwabHolding {
  symbol: string
  description: string
  qty: number
  price: number
  market_value: number
  cost_basis: number
  gain_dollar: number
  gain_pct: string
  asset_type: string
}

/** Positions snapshot normalized per account, with flattened holdings. */
export interface SchwabPositionsRecord {
  capture_id: string
  created_at: string
  account_name: string
  account_mask: string
  as_of: string
  total_value: number
  cost_basis: number
  gain_dollar: number
  gain_pct: string
  holdings: SchwabHolding[]
}

/**
 * Fetch the raw Schwab captures that the RSC page passes to client components.
 * This is the only actual API call — all shaping is done client-side.
 */
export const investmentsApi = {
  /** GET /api/v1/captures?source_provider=schwab&limit=200 */
  rawCaptures: (limit = 200): Promise<ListEnvelope<Capture>> =>
    request<ListEnvelope<Capture>>(
      `/captures${buildQueryString({ source_provider: 'schwab', limit })}`,
    ),
}

// ---------------------------------------------------------------------------
// voiceSessionApi — GET /api/v1/voice/sessions
// ---------------------------------------------------------------------------

/** Transcript turn as returned by the voice session API */
export interface TranscriptTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

/** Voice session record as returned by GET /api/v1/voice/sessions */
export interface VoiceSession {
  id: string
  session_key: string
  started_at: string         // ISO 8601
  ended_at: string | null    // null if session is still active
  duration_seconds: number | null
  turn_count: number | null
  transcript: TranscriptTurn[]
  summary: string | null
  captures_created: string[] // array of capture IDs linked to this session
  metadata: Record<string, unknown> | null
  created_at: string         // ISO 8601
}

export interface VoiceSessionsListParams {
  limit?: number
  offset?: number
}

export const voiceSessionApi = {
  /**
   * GET /api/v1/voice/sessions — paginated list of voice sessions,
   * ordered by started_at DESC.
   */
  list: (params: VoiceSessionsListParams = {}): Promise<ListEnvelope<VoiceSession>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<VoiceSession>>(`/voice/sessions${qs}`)
  },

  /**
   * GET /api/v1/voice/sessions/active — sessions with no ended_at.
   * Returns { items: VoiceSession[] } (not a paginated envelope).
   */
  active: (): Promise<{ items: VoiceSession[] }> => {
    return request<{ items: VoiceSession[] }>('/voice/sessions/active')
  },

  /**
   * GET /api/v1/voice/sessions/:id — single session with full transcript.
   */
  get: (id: string): Promise<VoiceSession> => {
    return request<VoiceSession>(`/voice/sessions/${encodeURIComponent(id)}`)
  },
}

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
  total_pages: number
  by_type: Record<string, number>
  orphaned_pages: number
  domains: string[]
  last_synthesized?: string | null
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

// ---------------------------------------------------------------------------
// emailApi — email drafts management (M3, screen 6.3)
//
// Endpoint map (see packages/core-api/src/routes/email.ts):
//   GET    /api/v1/email/drafts              → { items, total, limit, offset }
//   GET    /api/v1/email/drafts/:id          → EmailDraft
//   POST   /api/v1/email/drafts/:id/send     → { id, status, sent_at }
//   DELETE /api/v1/email/drafts/:id          → { id, status }
// ---------------------------------------------------------------------------

export type EmailDraftStatus = 'draft' | 'approved' | 'sent' | 'rejected' | 'failed';
export type EmailSendMode = 'review-required' | 'auto-send';

/** Email draft as returned by the API list/get endpoints. */
export interface EmailDraft {
  id: string;
  to_address: string;
  cc_address: string | null;
  subject: string;
  body: string;
  status: EmailDraftStatus;
  send_mode: EmailSendMode;
  source: string | null;
  approved_at: string | null;   // ISO 8601 or null
  sent_at: string | null;       // ISO 8601 or null
  capture_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;           // ISO 8601
  updated_at: string;           // ISO 8601
}

export interface EmailDraftsListParams {
  status?: EmailDraftStatus;
  limit?: number;
  offset?: number;
}

/** Response envelope from POST /api/v1/email/drafts/:id/send */
export interface EmailDraftSendResult {
  id: string;
  status: EmailDraftStatus;
  sent_at: string | null;
}

/** Response envelope from DELETE /api/v1/email/drafts/:id */
export interface EmailDraftRejectResult {
  id: string;
  status: EmailDraftStatus;
}

export const emailApi = {
  /**
   * GET /api/v1/email/drafts — paginated list of email drafts.
   * Optional status filter: 'draft' | 'approved' | 'sent' | 'rejected' | 'failed'.
   */
  list: (params: EmailDraftsListParams = {}): Promise<ListEnvelope<EmailDraft>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<EmailDraft>>(`/email/drafts${qs}`)
  },

  /**
   * GET /api/v1/email/drafts/:id — fetch a single draft.
   */
  get: (id: string): Promise<EmailDraft> => {
    return request<EmailDraft>(`/email/drafts/${encodeURIComponent(id)}`)
  },

  /**
   * POST /api/v1/email/drafts/:id/send — approve and send a draft.
   * Transitions draft status to 'approved' then 'sent' (or 'failed').
   */
  send: (id: string): Promise<EmailDraftSendResult> => {
    return request<EmailDraftSendResult>(
      `/email/drafts/${encodeURIComponent(id)}/send`,
      { method: 'POST' },
    )
  },

  /**
   * DELETE /api/v1/email/drafts/:id — reject and discard a draft.
   * Transitions draft status to 'rejected'.
   */
  reject: (id: string): Promise<EmailDraftRejectResult> => {
    return request<EmailDraftRejectResult>(
      `/email/drafts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    )
  },
}

// ---------------------------------------------------------------------------
// ingestApi — file uploads via the /api/v1/ingest/* endpoints (CS3.4)
// ---------------------------------------------------------------------------

/** Lifecycle status of a file_uploads row — mirrors FileUploadStatus in @open-brain/shared */
export type FileUploadStatus = 'pending' | 'processing' | 'parsed' | 'failed'

/** Ingest source type — matches the bind-mount subfolder */
export type IngestSourceType = 'financial' | 'utility'

/** Capture-id + short title snippet joined onto a file upload row */
export interface UploadCaptureSummary {
  id: string
  title_snippet: string
}

/** Single row from GET /api/v1/ingest/uploads */
export interface FileUploadRow {
  id: string
  filename: string
  size_bytes: number
  mime_type: string | null
  source_type: IngestSourceType
  parser_hint: string | null
  destination_path: string
  uploaded_at: string          // ISO 8601
  status: FileUploadStatus
  capture_ids: string[]
  captures: UploadCaptureSummary[]
  error_message: string | null
  processed_at: string | null  // ISO 8601 or null
  duration_ms: number | null
}

/** Paginated list envelope from GET /api/v1/ingest/uploads */
export interface ListUploadsResponse {
  uploads: FileUploadRow[]
  total: number
  limit: number
  offset: number
}

/** Response from POST /api/v1/ingest/upload */
export interface UploadFileResponse {
  upload_id: string
  status: FileUploadStatus
  filename: string
  size_bytes: number
  source_type: IngestSourceType
  parser_hint: string | null
  destination_path: string
  uploaded_at: string          // ISO 8601
}

/** Response from POST /api/v1/ingest/process-now and POST /api/v1/ingest/uploads/:id/process */
export interface ProcessNowResponse {
  source: IngestSourceType
  enqueued: boolean
  message?: string
}

export interface IngestUploadOptions {
  source_type?: IngestSourceType
  parser_hint?: string
}

export interface IngestListParams {
  limit?: number
  offset?: number
  status?: FileUploadStatus
  source_type?: IngestSourceType
}

export const ingestApi = {
  /**
   * POST /api/v1/ingest/upload — multipart file upload.
   * Streams FormData (field name: `file`). Does NOT set Content-Type — browser
   * sets it with the boundary automatically. Returns 201 with upload_id.
   */
  upload: async (file: File, opts: IngestUploadOptions = {}): Promise<UploadFileResponse> => {
    const formData = new FormData()
    formData.append('file', file, file.name)
    if (opts.source_type) formData.append('source_type', opts.source_type)
    if (opts.parser_hint) formData.append('parser_hint', opts.parser_hint)

    const url = `${getApiBase()}/ingest/upload`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // Do NOT set Content-Type — browser sets it with multipart boundary
        'X-Open-Brain-Caller': 'web-ui',
      },
      body: formData,
    })

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
      throw new HttpError(response.status, body, '/ingest/upload')
    }

    return response.json() as Promise<UploadFileResponse>
  },

  /**
   * GET /api/v1/ingest/uploads — paginated list of file upload rows.
   */
  list: (params: IngestListParams = {}): Promise<ListUploadsResponse> => {
    const qs = buildQueryString(params)
    return request<ListUploadsResponse>(`/ingest/uploads${qs}`)
  },

  /**
   * GET /api/v1/ingest/uploads/:id — single file upload row.
   */
  get: (id: string): Promise<FileUploadRow> => {
    return request<FileUploadRow>(`/ingest/uploads/${encodeURIComponent(id)}`)
  },

  /**
   * POST /api/v1/ingest/uploads/:id/process — re-enqueue a specific upload for processing.
   * Used to retry failed uploads. Returns 200 with enqueued: true on success.
   */
  process: (id: string): Promise<ProcessNowResponse> => {
    return request<ProcessNowResponse>(
      `/ingest/uploads/${encodeURIComponent(id)}/process`,
      { method: 'POST' },
    )
  },

  /**
   * POST /api/v1/ingest/process-now — manual inbox re-trigger (no upload required).
   * Fans out a synthetic job per source so the worker can scan the sidecar inbox.
   */
  processNow: (source?: IngestSourceType): Promise<ProcessNowResponse> => {
    const qs = source ? buildQueryString({ source }) : ''
    return request<ProcessNowResponse>(`/ingest/process-now${qs}`, { method: 'POST' })
  },
}

// ---------------------------------------------------------------------------
// systemHealthApi — /api/v1/system/* operational metrics
// ---------------------------------------------------------------------------

/** Per-queue BullMQ stats as returned by GET /api/v1/system/health */
export interface QueueStats {
  name: string
  waiting: number
  active: number
  failed: number
  delayed: number
  status: 'healthy' | 'degraded' | 'unhealthy'
}

/** Redis memory summary */
export interface RedisMemory {
  used_bytes: number
  max_bytes: number
  used_pct: number
  status: 'healthy' | 'degraded' | 'unhealthy'
}

/** Monthly LLM spend summary */
export interface MonthlySpend {
  month: string
  total_usd: number
  non_claude_usd: number
  status: 'healthy' | 'degraded' | 'unhealthy'
}

/** Last run record for a single skill */
export interface SkillLastRun {
  skill_name: string
  last_run_at: string
  duration_ms: number | null
  output_summary: string | null
}

/** Wiki health status from system health snapshot */
export interface WikiHealthStatus {
  configured: boolean
  status: 'healthy' | 'degraded' | 'unhealthy'
  repo_url: string | null
  page_count: number
  last_commit_date: string | null
  last_commit_message: string | null
  error: string | null
}

/** Full system health snapshot from GET /api/v1/system/health */
export interface SystemHealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  uptime_s: number
  queues: QueueStats[]
  redis_memory: RedisMemory
  monthly_spend: MonthlySpend
  skill_last_runs: SkillLastRun[]
  wiki: WikiHealthStatus
}

/** One pipeline flow entry from GET /api/v1/system/flows */
export interface PipelineFlowEntry {
  capture_id: string
  trace_id: string | null
  pipeline_status: string
  created_at: string
  stages: Array<{
    stage: string
    status: string
    duration_ms: number | null
    error: string | null
    started_at: string | null
  }>
}

/** Container health entry from GET /api/v1/system/infrastructure */
export interface ContainerHealthEntry {
  id: string
  timestamp: string
  container_name: string
  healthy: boolean
  response_ms: number | null
  error: string | null
}

/** Backup log entry from GET /api/v1/system/infrastructure */
export interface BackupLogEntry {
  id: string
  timestamp: string
  backup_type: string
  file_path: string | null
  size_bytes: number | null
  duration_seconds: number | null
  status: string
  error: string | null
  pruned_count: number
}

/** Cost summary from GET /api/v1/system/infrastructure */
export interface CostSummary {
  month: string
  total_usd: number
  by_model: Array<{ model: string; cost_usd: number; call_count: number }>
}

/** Infrastructure data envelope */
export interface InfrastructureData {
  container_health: ContainerHealthEntry[]
  backups: BackupLogEntry[]
  cost: CostSummary
}

export const systemHealthApi = {
  /** GET /api/v1/system/health — full operational health snapshot */
  snapshot: (): Promise<SystemHealthSnapshot> => {
    return request<SystemHealthSnapshot>('/system/health')
  },

  /** GET /api/v1/system/flows?limit=N — recent pipeline flow entries */
  flows: (limit = 20): Promise<{ flows: PipelineFlowEntry[] }> => {
    const qs = buildQueryString({ limit })
    return request<{ flows: PipelineFlowEntry[] }>(`/system/flows${qs}`)
  },

  /** GET /api/v1/system/infrastructure — container health, backups, cost */
  infrastructure: (): Promise<InfrastructureData> => {
    return request<InfrastructureData>('/system/infrastructure')
  },
}

// ---------------------------------------------------------------------------
// adminQueuesApi — queue clear via POST /api/v1/admin/queues/:name/clear
// ---------------------------------------------------------------------------

export type ClearableState = 'failed' | 'completed' | 'delayed'

export interface QueueClearResult {
  queue: string
  state: ClearableState
  cleared_count: number
  cleared_at: string
}

export const adminQueuesApi = {
  /**
   * POST /api/v1/admin/queues/:name/clear — clears jobs in a given state.
   * Default state: 'failed'. No adminAuth — protected by queue name whitelist.
   */
  clear: (
    name: string,
    state: ClearableState = 'failed',
  ): Promise<QueueClearResult> => {
    return request<QueueClearResult>(
      `/admin/queues/${encodeURIComponent(name)}/clear`,
      { method: 'POST', body: JSON.stringify({ state }) },
    )
  },
}

// ---------------------------------------------------------------------------
// skillsListApi — list skills via GET /api/v1/skills (read side only)
// The write side (trigger) already exists in skillsApi above.
// ---------------------------------------------------------------------------

/** One skill record as returned by GET /api/v1/skills */
export interface SkillRecord {
  name: string
  schedule: string | null
  description: string | null
  last_run_at: string | null
  last_duration_ms: number | null
  last_output_summary: string | null
  last_input_summary: string | null
}

export const skillsListApi = {
  /** GET /api/v1/skills — full list of configured skills + last-run metadata */
  list: (): Promise<{ skills: SkillRecord[] }> => {
    return request<{ skills: SkillRecord[] }>('/skills')
  },

  /**
   * PATCH /api/v1/skills/:name — update a skill's cron schedule.
   * Body: { schedule: string }. Returns { name, schedule, updated_at }.
   */
  updateSchedule: (
    name: string,
    schedule: string,
  ): Promise<{ name: string; schedule: string; updated_at: string }> => {
    return request<{ name: string; schedule: string; updated_at: string }>(
      `/skills/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: JSON.stringify({ schedule }) },
    )
  },
}

// ---------------------------------------------------------------------------
// mcpActivityApi — paginated MCP tool invocation log
// ---------------------------------------------------------------------------

/** One MCP activity record */
export interface McpActivityEntry {
  id: string
  timestamp: string
  tool_name: string
  client_id: string | null
  duration_ms: number | null
  success: boolean
  input_summary: string | null
  output_summary: string | null
}

export interface McpActivityListParams {
  limit?: number
  offset?: number
  tool_name?: string
  client_id?: string
  since?: string
}

export const mcpActivityApi = {
  /**
   * GET /api/v1/mcp/activity — paginated MCP activity log.
   * Supports filtering by tool_name, client_id, since (ISO 8601).
   */
  list: (params: McpActivityListParams = {}): Promise<ListEnvelope<McpActivityEntry>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<McpActivityEntry>>(`/mcp/activity${qs}`)
  },
}

// ---------------------------------------------------------------------------
// adminApi — Slack channel management via /api/v1/admin/slack/* endpoints
//
// Endpoint map (see packages/core-api/src/routes/admin.ts):
//   GET  /api/v1/admin/slack/channels              → { channels: SlackChannelInfo[] }
//   POST /api/v1/admin/slack/channels/:id/archive  → ArchiveResult
//
// NOTE: These endpoints require SLACK_BOT_TOKEN or SLACK_USER_TOKEN to be set
// on core-api. If neither is set, the API returns 503.
// ---------------------------------------------------------------------------

/** Slack channel info as returned by GET /api/v1/admin/slack/channels */
export interface SlackChannel {
  id: string
  name: string
  member_count: number
  last_activity: string | null
  days_inactive: number
  topic?: string
  purpose?: string
  is_archived: boolean
}

/** Result of POST /api/v1/admin/slack/channels/:id/archive */
export interface SlackArchiveResult {
  ok: boolean
  channel_id: string
  archived_at: string
}

/** Step-1 response from POST /admin/reset-data (no confirm field) */
export interface AdminResetTokenResponse {
  token: string
  expires_in: number    // seconds (typically 300 = 5 minutes)
  message: string
}

/** Step-2 response from POST /admin/reset-data (with confirm + token) */
export interface AdminResetConfirmResponse {
  cleared: string[]
  preserved: string[]
  wiped_at: string
  backup_path: string
  audit_id: string
}

export const adminApi = {
  /**
   * GET /api/v1/admin/slack/channels — list all public Slack channels with
   * activity metadata (member count, last_activity, days_inactive).
   * Returns 503 if no Slack token is configured.
   */
  getSlackChannels: (): Promise<{ channels: SlackChannel[] }> => {
    return request<{ channels: SlackChannel[] }>('/admin/slack/channels')
  },

  /**
   * POST /api/v1/admin/slack/channels/:id/archive — archive a Slack channel by ID.
   * Requires channels:write scope on the configured Slack token.
   */
  archiveSlackChannel: (id: string): Promise<SlackArchiveResult> => {
    return request<SlackArchiveResult>(
      `/admin/slack/channels/${encodeURIComponent(id)}/archive`,
      { method: 'POST' },
    )
  },

  /**
   * POST /api/v1/admin/reset-data (Step 1) — request a single-use reset token.
   *
   * No body sent. Server issues a 5-minute single-use Redis token and records
   * the request in admin_audit. Returns token + expires_in.
   *
   * Per CLAUDE.md: no adminAuth() — protection is origin allowlist + two-step
   * token + confirmation phrase + rate limiter. Do not add Bearer auth here.
   *
   * The origin must be brain.troy-davis.com — the server performs the
   * authoritative check (fail-closed: unset/unknown NODE_ENV = production).
   */
  requestResetToken: (): Promise<AdminResetTokenResponse> => {
    return request<AdminResetTokenResponse>('/admin/reset-data', { method: 'POST' })
  },

  /**
   * POST /api/v1/admin/reset-data (Step 2) — execute the data wipe.
   *
   * Requires `confirm: "WIPE ALL DATA"` and the token from step 1.
   * Server truncates all tables except admin_audit; pre-wipe pg_dump to
   * /backup/pre-wipe/<ISO>.sql (admin_prewipe_backup volume).
   *
   * Every attempt (executed/blocked/error) writes to admin_audit.
   * admin_audit is excluded from TRUNCATE — code-level test asserts this.
   */
  confirmReset: (
    token: string,
    phrase: 'WIPE ALL DATA',
  ): Promise<AdminResetConfirmResponse> => {
    return request<AdminResetConfirmResponse>('/admin/reset-data', {
      method: 'POST',
      body: JSON.stringify({ confirm: phrase, token }),
    })
  },
}

// ---------------------------------------------------------------------------
// configApi — read integration health via GET /api/v1/config/integrations
// ---------------------------------------------------------------------------

export interface IntegrationsResponse {
  integrations: Integration[];
}

export const configApi = {
  /**
   * GET /api/v1/config/integrations — list all configured integrations with
   * health status. Used by the Settings → Sources section.
   */
  integrations: (): Promise<IntegrationsResponse> => {
    return request<IntegrationsResponse>('/config/integrations')
  },
}
