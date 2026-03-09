/**
 * CoreApiClient — HTTP client for communicating with the Open Brain Core API.
 * Provides type-safe methods for captures, search, stats, triggers, entities, sessions, and bets.
 */

// Types

export interface CreateCapturePayload {
  content: string
  capture_type: string
  brain_view: string
  source: string
  metadata?: {
    source_metadata?: Record<string, unknown>
    tags?: string[]
  }
}

export interface SearchPayload {
  query: string
  limit?: number
  offset?: number
  threshold?: number
  brain_views?: string[]
  temporal_weight?: number
  search_mode?: 'fts' | 'vector' | 'hybrid'
}

export interface PreExtracted {
  entities?: Array<{ name: string; type: string }>
  topics?: string[]
  sentiment?: string
}

export interface CaptureResult {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  pipeline_status: string
  tags: string[]
  created_at: string
  pre_extracted?: PreExtracted
}

export interface SearchResult {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  score: number
  created_at: string
  pre_extracted?: PreExtracted
}

export interface SearchResponse {
  query: string
  total: number
  results: SearchResult[]
}

export interface BrainStats {
  total_captures: number
  by_source: Record<string, number>
  by_type: Record<string, number>
  by_view: Record<string, number>
  pipeline_health: {
    pending: number
    processing: number
    complete: number
    failed: number
  }
}

export interface TriggerRecord {
  id: string
  name: string
  query_text: string
  threshold: number
  cooldown_minutes: number
  delivery_channel: string
  is_active: boolean
  fire_count: number
  last_fired_at: string | null
  created_at: string
}

/** A capture that matched a trigger test query */
export interface TriggerMatch {
  id: string
  content: string
  capture_type: string
  brain_view: string
  created_at: string
  similarity: number
}

export interface EntityRecord {
  id: string
  name: string
  type: string
  aliases: string[]
  capture_count: number
  last_seen_at?: string
  created_at?: string
}

export interface EntityMergeResult {
  message: string
  source_id: string
  target_id: string
}

export interface EntitySplitResult {
  message: string
  source_entity_id: string
  new_entity_id: string
  alias: string
}

export interface SessionRecord {
  id: string
  session_type: string
  status: string
  config: unknown | null
  summary: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface BetRecord {
  id: string
  statement: string
  confidence: number
  domain: string
  resolution_date: string
  resolution: string | null
  resolution_notes: string | null
  session_id: string | null
  created_at: string
  updated_at: string
}

export interface SynthesizePayload {
  query: string
  limit?: number
}

export interface SynthesizeResponse {
  response: string
}

export interface PipelineStatus {
  queues: Record<string, {
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
  }>
  overall: {
    pending: number
    processing: number
    complete: number
    failed: number
  }
}

export interface RecentCapture {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  created_at: string
}

export interface SkillLastRun {
  skill_name: string
  status: string
  completed_at: string
  duration_ms: number
  captures_queried: number
  result_summary: string
}

// Client implementation

export class CoreApiClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Strip trailing slash
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    }

    return response.json()
  }

  // Captures

  async captures_create(payload: CreateCapturePayload): Promise<CaptureResult> {
    return this.request<CaptureResult>('/api/v1/captures', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async captures_get(id: string): Promise<CaptureResult> {
    return this.request<CaptureResult>(`/api/v1/captures/${id}`)
  }

  async captures_list(params?: { limit?: number; source?: string; capture_type?: string }): Promise<{ total: number; captures: RecentCapture[] }> {
    const query = new URLSearchParams()
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.source) query.set('source', params.source)
    if (params?.capture_type) query.set('capture_type', params.capture_type)
    const qs = query.toString()
    return this.request<{ total: number; captures: RecentCapture[] }>(`/api/v1/captures${qs ? `?${qs}` : ''}`)
  }

  async captures_retry(id: string): Promise<void> {
    await this.request<void>(`/api/v1/captures/${id}/retry`, { method: 'POST' })
  }

  // Search

  async search_query(payload: SearchPayload): Promise<SearchResponse> {
    return this.request<SearchResponse>('/api/v1/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  // Synthesize

  async synthesize_query(payload: SynthesizePayload): Promise<SynthesizeResponse> {
    return this.request<SynthesizeResponse>('/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  // Stats

  async stats_get(): Promise<BrainStats> {
    return this.request<BrainStats>('/api/v1/stats')
  }

  // Skills

  async skills_trigger(skillName: string, overrides?: Record<string, unknown>): Promise<{ queued: boolean; job_id: string }> {
    return this.request<{ queued: boolean; job_id: string }>(`/api/v1/skills/${skillName}/trigger`, {
      method: 'POST',
      body: JSON.stringify(overrides ?? {}),
    })
  }

  async skills_last_run(skillName: string): Promise<SkillLastRun | null> {
    return this.request<SkillLastRun | null>(`/api/v1/skills/${skillName}/last-run`)
  }

  // Triggers

  async triggers_list(): Promise<{ triggers: TriggerRecord[] }> {
    return this.request<{ triggers: TriggerRecord[] }>('/api/v1/triggers')
  }

  async triggers_create(payload: { name: string; query_text: string; threshold?: number; cooldown_minutes?: number }): Promise<TriggerRecord> {
    return this.request<TriggerRecord>('/api/v1/triggers', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async triggers_delete(nameOrId: string): Promise<void> {
    await this.request<void>(`/api/v1/triggers/${encodeURIComponent(nameOrId)}`, { method: 'DELETE' })
  }

  async triggers_test(payload: { query_text: string; limit?: number }): Promise<{ query_text: string; matches: TriggerMatch[] }> {
    return this.request<{ query_text: string; matches: TriggerMatch[] }>('/api/v1/triggers/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  // Entities

  async entities_list(params?: { limit?: number }): Promise<{ total: number; entities: EntityRecord[] }> {
    const query = params?.limit ? `?limit=${params.limit}` : ''
    return this.request<{ total: number; entities: EntityRecord[] }>(`/api/v1/entities${query}`)
  }

  async entities_search(name: string): Promise<{ total: number; entities: EntityRecord[] }> {
    const query = encodeURIComponent(name)
    return this.request<{ total: number; entities: EntityRecord[] }>(`/api/v1/entities/search?q=${query}`)
  }

  async entities_get(id: string): Promise<EntityRecord & { captures: CaptureResult[] }> {
    return this.request<EntityRecord & { captures: CaptureResult[] }>(`/api/v1/entities/${id}`)
  }

  async entities_merge(sourceId: string, targetId: string): Promise<EntityMergeResult> {
    return this.request<EntityMergeResult>('/api/v1/entities/merge', {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
    })
  }

  async entities_split(entityId: string, alias: string): Promise<EntitySplitResult> {
    return this.request<EntitySplitResult>(`/api/v1/entities/${entityId}/split`, {
      method: 'POST',
      body: JSON.stringify({ alias }),
    })
  }

  // Sessions

  async sessions_list(status: string, limit: number): Promise<{ items: SessionRecord[]; total: number; limit: number; offset: number }> {
    return this.request<{ items: SessionRecord[]; total: number; limit: number; offset: number }>(
      `/api/v1/sessions?status=${status}&limit=${limit}`
    )
  }

  async sessions_create(type: string): Promise<{ session: SessionRecord; first_message: string }> {
    return this.request<{ session: SessionRecord; first_message: string }>('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ type }),
    })
  }

  async sessions_respond(id: string, message: string): Promise<{ session: SessionRecord; bot_message: string }> {
    return this.request<{ session: SessionRecord; bot_message: string }>(`/api/v1/sessions/${id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
  }

  async sessions_pause(id: string): Promise<{ session: SessionRecord }> {
    return this.request<{ session: SessionRecord }>(`/api/v1/sessions/${id}/pause`, { method: 'POST' })
  }

  async sessions_resume(id: string): Promise<{ session: SessionRecord; context_message: string }> {
    return this.request<{ session: SessionRecord; context_message: string }>(`/api/v1/sessions/${id}/resume`, { method: 'POST' })
  }

  async sessions_complete(id: string): Promise<{ session: SessionRecord; summary: string }> {
    return this.request<{ session: SessionRecord; summary: string }>(`/api/v1/sessions/${id}/complete`, { method: 'POST' })
  }

  async sessions_abandon(id: string): Promise<{ session: SessionRecord }> {
    return this.request<{ session: SessionRecord }>(`/api/v1/sessions/${id}/abandon`, { method: 'POST' })
  }

  // Bets

  async bets_list(status?: string, limit = 20): Promise<{ items: BetRecord[]; total: number; limit: number; offset: number }> {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    params.set('limit', String(limit))
    return this.request<{ items: BetRecord[]; total: number; limit: number; offset: number }>(`/api/v1/bets?${params}`)
  }

  async bets_create(payload: { statement: string; confidence: number; domain?: string }): Promise<BetRecord> {
    return this.request<BetRecord>('/api/v1/bets', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async bets_expiring(days: number): Promise<{ items: BetRecord[]; days_ahead: number }> {
    return this.request<{ items: BetRecord[]; days_ahead: number }>(`/api/v1/bets/expiring?days=${days}`)
  }

  async bets_resolve(id: string, payload: { resolution: 'correct' | 'incorrect' | 'ambiguous'; evidence?: string }): Promise<BetRecord> {
    return this.request<BetRecord>(`/api/v1/bets/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  // Pipeline

  async pipeline_health(): Promise<PipelineStatus> {
    return this.request<PipelineStatus>('/api/v1/admin/pipeline/health')
  }
}
