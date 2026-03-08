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
  description: string
  enabled: boolean
  conditions: Record<string, unknown>
  actions: Record<string, unknown>
  created_at: string
}

export interface TriggerMatch {
  trigger_id: string
  trigger_name: string
  matched: boolean
  confidence: number
}

export interface EntityRecord {
  id: string
  name: string
  type: string
  aliases: string[]
  capture_count: number
  created_at: string
}

export interface EntityMergeResult {
  merged_entity_id: string
  merged_count: number
}

export interface EntitySplitResult {
  new_entities: string[]
}

export interface SessionRecord {
  id: string
  type: string
  brain_view: string
  status: string
  messages: Array<{ role: string; content: string }>
  created_at: string
  updated_at: string
}

export interface BetRecord {
  id: string
  description: string
  due_date: string
  brain_view: string
  status: string
  outcome?: string
  created_at: string
}

export interface SynthesizePayload {
  query: string
  limit?: number
}

export interface SynthesizeResponse {
  response: string
}

export interface PipelineStatus {
  queue_depth: {
    pending: number
    active: number
    completed: number
    failed: number
    delayed: number
  }
  stale_count: number
  failed_jobs: Array<{
    id: string
    name: string
    failed_reason: string
  }>
}

export interface RecentCapture {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  created_at: string
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

  // Triggers

  async triggers_list(): Promise<TriggerRecord[]> {
    return this.request<TriggerRecord[]>('/api/v1/triggers')
  }

  async triggers_test(captureId: string): Promise<TriggerMatch[]> {
    return this.request<TriggerMatch[]>(`/api/v1/triggers/test/${captureId}`)
  }

  // Entities

  async entities_list(params?: { limit?: number }): Promise<{ total: number; entities: EntityRecord[] }> {
    const query = params?.limit ? `?limit=${params.limit}` : ''
    return this.request<{ total: number; entities: EntityRecord[] }>(`/api/v1/entities${query}`)
  }

  async entities_get(id: string): Promise<EntityRecord & { captures: CaptureResult[] }> {
    return this.request<EntityRecord & { captures: CaptureResult[] }>(`/api/v1/entities/${id}`)
  }

  async entities_merge(sourceIds: string[], targetName: string): Promise<EntityMergeResult> {
    return this.request<EntityMergeResult>('/api/v1/entities/merge', {
      method: 'POST',
      body: JSON.stringify({ source_ids: sourceIds, target_name: targetName }),
    })
  }

  async entities_split(entityId: string, newNames: string[]): Promise<EntitySplitResult> {
    return this.request<EntitySplitResult>(`/api/v1/entities/${entityId}/split`, {
      method: 'POST',
      body: JSON.stringify({ new_names: newNames }),
    })
  }

  // Sessions

  async sessions_list(params?: { limit?: number }): Promise<{ total: number; sessions: SessionRecord[] }> {
    const query = params?.limit ? `?limit=${params.limit}` : ''
    return this.request<{ total: number; sessions: SessionRecord[] }>(`/api/v1/sessions${query}`)
  }

  async sessions_get(id: string): Promise<SessionRecord> {
    return this.request<SessionRecord>(`/api/v1/sessions/${id}`)
  }

  async sessions_create(type: string, brainView: string): Promise<SessionRecord> {
    return this.request<SessionRecord>('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ type, brain_view: brainView }),
    })
  }

  async sessions_respond(id: string, message: string): Promise<SessionRecord> {
    return this.request<SessionRecord>(`/api/v1/sessions/${id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
  }

  async sessions_close(id: string): Promise<SessionRecord> {
    return this.request<SessionRecord>(`/api/v1/sessions/${id}/close`, {
      method: 'POST',
    })
  }

  // Bets

  async bets_list(params?: { status?: string }): Promise<{ total: number; bets: BetRecord[] }> {
    const query = params?.status ? `?status=${params.status}` : ''
    return this.request<{ total: number; bets: BetRecord[] }>(`/api/v1/bets${query}`)
  }

  async bets_get(id: string): Promise<BetRecord> {
    return this.request<BetRecord>(`/api/v1/bets/${id}`)
  }

  async bets_create(description: string, dueDate: string, brainView: string): Promise<BetRecord> {
    return this.request<BetRecord>('/api/v1/bets', {
      method: 'POST',
      body: JSON.stringify({ description, due_date: dueDate, brain_view: brainView }),
    })
  }

  async bets_resolve(id: string, outcome: string): Promise<BetRecord> {
    return this.request<BetRecord>(`/api/v1/bets/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome }),
    })
  }

  // Pipeline status

  async pipeline_status(): Promise<PipelineStatus> {
    return this.request<PipelineStatus>('/api/v1/admin/pipeline/status')
  }

  // Skills

  async skills_run(skillName: string, params?: Record<string, unknown>): Promise<{ job_id: string }> {
    return this.request<{ job_id: string }>(`/api/v1/skills/${skillName}/run`, {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    })
  }

  // Brief

  async briefs_latest(): Promise<{ id: string; content: string; created_at: string } | null> {
    return this.request<{ id: string; content: string; created_at: string } | null>('/api/v1/briefs/latest')
  }
}
