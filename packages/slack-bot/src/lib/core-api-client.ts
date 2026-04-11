/**
 * CoreApiClient — HTTP client for communicating with the Open Brain Core API.
 * Provides type-safe methods for captures, search, stats, triggers, entities, sessions, and bets.
 */

// Re-export all types for backward compatibility
export * from './core-api-types.js'

import type {
  CreateCapturePayload,
  CaptureResult,
  SearchPayload,
  SearchResponse,
  SynthesizePayload,
  SynthesizeResponse,
  BrainStats,
  TriggerRecord,
  TriggerMatch,
  EntityRecord,
  EntityMergeResult,
  EntitySplitResult,
  SessionRecord,
  BetRecord,
  PipelineStatus,
  RecentCapture,
  SkillLastRun,
  EmailDraftCreatePayload,
  EmailDraftRecord,
  EmailDraftListResult,
} from './core-api-types.js'

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
    // API returns { items, total, limit, offset } — map items → captures
    const raw = await this.request<{ total: number; items: RecentCapture[] }>(`/api/v1/captures${qs ? `?${qs}` : ''}`)
    return { total: raw.total, captures: raw.items ?? [] }
  }

  async captures_retry(id: string): Promise<void> {
    await this.request<void>(`/api/v1/captures/${id}/retry`, { method: 'POST' })
  }

  // Search

  async search_query(payload: SearchPayload): Promise<SearchResponse> {
    const raw = await this.request<{ query: string; total: number; results: Array<{ capture: CaptureResult; score: number }> }>('/api/v1/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return {
      query: raw.query,
      total: raw.total,
      results: (raw.results ?? []).map(r => ({
        id: r.capture.id,
        content: r.capture.content,
        capture_type: r.capture.capture_type,
        brain_view: r.capture.brain_view,
        source: r.capture.source,
        score: r.score,
        created_at: r.capture.created_at,
        pre_extracted: r.capture.pre_extracted,
      })),
    }
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
    // Use the logs endpoint (no dedicated last-run route exists)
    const res = await this.request<{ data: Array<{
      skill_name: string; status: string; completed_at: string | Date;
      duration_ms: number | null; output: string | null; result: Record<string, unknown> | null
    }> }>(`/api/v1/skills/${skillName}/logs?limit=1`)
    const row = res.data?.[0]
    if (!row) return null
    return {
      skill_name: row.skill_name,
      status: row.status,
      completed_at: String(row.completed_at),
      duration_ms: row.duration_ms ?? 0,
      captures_queried: (row.result as { captures_queried?: number } | null)?.captures_queried ?? 0,
      result_summary: row.output ?? '',
    }
  }

  // Triggers

  async triggers_list(): Promise<{ triggers: TriggerRecord[] }> {
    return this.request<{ triggers: TriggerRecord[] }>('/api/v1/triggers')
  }

  async triggers_create(payload: { name: string; queryText: string; threshold?: number; cooldown_minutes?: number }): Promise<TriggerRecord> {
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
    // API returns { items, total, limit, offset } — map items → entities
    // API uses mention_count (not capture_count) and entity_type (not type)
    type RawEntity = Omit<EntityRecord, 'capture_count' | 'type'> & { mention_count: number; entity_type: string }
    const raw = await this.request<{ total: number; items: RawEntity[] }>(`/api/v1/entities${query}`)
    const entities = (raw.items ?? []).map(e => ({ ...e, capture_count: e.mention_count, type: e.entity_type }))
    return { total: raw.total, entities }
  }

  async entities_search(name: string): Promise<{ total: number; entities: EntityRecord[] }> {
    // API uses ?name= param; returns { entity } (single) or 404
    // API uses mention_count (not capture_count) and entity_type (not type)
    try {
      type RawEntity = Omit<EntityRecord, 'capture_count' | 'type'> & { mention_count: number; entity_type: string }
      const raw = await this.request<{ entity: RawEntity }>(`/api/v1/entities?name=${encodeURIComponent(name)}`)
      const entity = { ...raw.entity, capture_count: raw.entity.mention_count, type: raw.entity.entity_type }
      return { total: 1, entities: [entity] }
    } catch (err) {
      // 404 = entity not found — return empty list so callers can show "no match" message
      if (err instanceof Error && err.message.startsWith('HTTP 404')) {
        return { total: 0, entities: [] }
      }
      throw err
    }
  }

  async entities_get(id: string): Promise<EntityRecord & { captures: CaptureResult[] }> {
    // API uses entity_type (not type) — map for formatter compatibility
    type RawResult = Omit<EntityRecord, 'type'> & { entity_type: string; captures: CaptureResult[] }
    const raw = await this.request<RawResult>(`/api/v1/entities/${id}`)
    return { ...raw, type: raw.entity_type }
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
      `/api/v1/sessions?status_filter=${status}&limit=${limit}`
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
    return this.request<BetRecord>(`/api/v1/bets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
  }

  // Pipeline

  async pipeline_health(): Promise<PipelineStatus> {
    return this.request<PipelineStatus>('/api/v1/admin/pipeline/health')
  }

  // Email drafts

  async email_drafts_create(payload: EmailDraftCreatePayload): Promise<EmailDraftRecord> {
    return this.request<EmailDraftRecord>('/api/v1/email/drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async email_drafts_list(status?: string, limit = 20): Promise<EmailDraftListResult> {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    params.set('limit', String(limit))
    return this.request<EmailDraftListResult>(`/api/v1/email/drafts?${params}`)
  }

  async email_drafts_get(id: string): Promise<EmailDraftRecord> {
    return this.request<EmailDraftRecord>(`/api/v1/email/drafts/${id}`)
  }

  async email_drafts_send(id: string): Promise<EmailDraftRecord> {
    return this.request<EmailDraftRecord>(`/api/v1/email/drafts/${id}/send`, {
      method: 'POST',
    })
  }

  async email_drafts_reject(id: string): Promise<EmailDraftRecord> {
    return this.request<EmailDraftRecord>(`/api/v1/email/drafts/${id}`, {
      method: 'DELETE',
    })
  }
}
