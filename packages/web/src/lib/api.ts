/**
 * API client for Open Brain Core API
 */

import type { Capture, BrainStats, SearchFilters, SearchResult, SynthesisResult, Entity, Skill, SkillLog, Trigger, Bet, PipelineHealth, SystemHealthData, SystemHealthSnapshot, WikiPageMeta, WikiPageFull, WikiRecentChange, WikiLintReport, ActivityFeedItem, McpActivityEntry, AIRoutingResponse, IntegrationStatus, EmailDraft, VoiceSession, InfrastructureData, PipelineFlowEntry } from './types'

const API_BASE = '/api/v1'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API ${response.status}: ${errorText}`)
  }

  return response.json()
}

function buildQueryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value))
    }
  }
  const qs = query.toString()
  return qs ? `?${qs}` : ''
}

// Captures API

export const capturesApi = {
  list: async (params?: { limit?: number; offset?: number; source?: string; capture_type?: string; brain_view?: string }) => {
    const qs = buildQueryString(params ?? {})
    // API returns { items, total, limit, offset } — normalize to { data, total, limit, offset }
    const raw = await request<{ items: Capture[]; total: number; limit: number; offset: number }>(`/captures${qs}`)
    return { data: raw.items ?? [], total: raw.total, limit: raw.limit, offset: raw.offset }
  },

  get: (id: string) => {
    return request<Capture>(`/captures/${id}`)
  },

  create: (payload: { content: string; capture_type: string; brain_view: string; source?: string }) => {
    return request<Capture>('/captures', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
}

// Stats API

export const statsApi = {
  get: () => {
    return request<BrainStats>('/stats')
  },
}

// Search API

export const searchApi = {
  search: async (filters: SearchFilters): Promise<SearchResult> => {
    // API returns { results: [{ capture, score, ... }], total, query }
    // Frontend expects { captures: Capture[], total, query, hybrid }
    const raw = await request<{ results: Array<{ capture: Capture; score: number }>; total: number; query: string }>('/search', {
      method: 'POST',
      body: JSON.stringify(filters),
    })
    return {
      captures: raw.results.map(r => r.capture),
      total: raw.total,
      query: raw.query,
      hybrid: filters.hybrid ?? true,
    }
  },
}

// Synthesize API

export const synthesizeApi = {
  query: (query: string, limit = 20) => {
    return request<SynthesisResult>('/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    })
  },
}

// Entities API

type RawEntity = Omit<Entity, 'type' | 'capture_count' | 'first_seen' | 'last_seen'> & {
  entity_type: string; mention_count: number; first_seen_at?: string; last_seen_at?: string
  linked_captures?: Capture[]
}

function mapRawEntity(e: RawEntity): Entity {
  return {
    ...e,
    type: e.entity_type as Entity['type'],
    capture_count: e.mention_count,
    first_seen: e.first_seen_at ?? '',
    last_seen: e.last_seen_at ?? '',
    captures: e.linked_captures ?? (e as unknown as { captures?: Capture[] }).captures ?? [],
  }
}

export const entitiesApi = {
  list: async (params?: { type_filter?: string; sort_by?: string; limit?: number }) => {
    const qs = buildQueryString(params ?? {})
    // API returns { items, total } — normalize to { data, total }
    // API uses entity_type (not type), mention_count (not capture_count), first/last_seen_at
    const raw = await request<{ items: RawEntity[]; total: number }>(`/entities${qs}`)
    const data = (raw.items ?? []).map(mapRawEntity)
    return { data, total: raw.total }
  },

  get: async (id: string): Promise<Entity & { captures: Capture[] }> => {
    // API returns entity_type, first_seen_at, last_seen_at, linked_captures — remap to Entity shape
    const raw = await request<RawEntity>(`/entities/${id}`)
    const entity = mapRawEntity(raw)
    return entity as Entity & { captures: Capture[] }
  },

  getCaptures: (_id: string) => {
    // No dedicated endpoint — captures are included in get(). Returns empty to avoid 404.
    return Promise.resolve({ data: [] as Capture[] })
  },

  merge: (sourceId: string, targetId: string) => {
    return request<{ message: string; source_id: string; target_id: string }>(`/entities/${sourceId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_id: targetId }),
    })
  },

  split: (entityId: string, alias: string) => {
    return request<{ message: string; source_entity_id: string; new_entity_id: string; alias: string }>(`/entities/${entityId}/split`, {
      method: 'POST',
      body: JSON.stringify({ alias }),
    })
  },
}

// Skills API

export const skillsApi = {
  list: async () => {
    // API returns { skills: [...] } — normalize to { data: Skill[] }
    type RawSkill = { name: string; schedule: string | null; description: string | null; last_run_at: string | null; last_run_status?: string | null }
    const raw = await request<{ skills: RawSkill[] }>('/skills')
    const data: Skill[] = (raw.skills ?? []).map(s => ({
      id: s.name,
      name: s.name,
      description: s.description ?? '',
      enabled: true,
      schedule: s.schedule ?? undefined,
      last_run_at: s.last_run_at ?? undefined,
      last_run_status: s.last_run_status ?? undefined,
    }))
    return { data }
  },

  trigger: (skillName: string, overrides?: Record<string, unknown>) => {
    return request<{ job_id: string }>(`/skills/${skillName}/trigger`, {
      method: 'POST',
      body: JSON.stringify(overrides ?? {}),
    })
  },

  updateSchedule: (skillName: string, schedule: string) => {
    return request<{ name: string; schedule: string; updated_at: string }>(`/skills/${skillName}`, {
      method: 'PATCH',
      body: JSON.stringify({ schedule }),
    })
  },

  logs: (skillName: string) => {
    return request<SkillLog[]>(`/skills/${skillName}/logs`)
  },

  getLogs: (skillName: string) => {
    return request<{ data: SkillLog[] }>(`/skills/${skillName}/logs`)
  },

  latestBrief: () => {
    return request<{ id: string; content: string; created_at: string } | null>('/briefs/latest')
  },
}

// Triggers API

/** Raw trigger record shape returned by the backend API */
type RawTrigger = {
  id: string
  name: string
  description: string | null
  condition_text: string
  threshold: number
  action: string
  action_config: Record<string, unknown> | null
  enabled: boolean
  last_triggered_at: string | null
  trigger_count: number
  created_at: string
  updated_at: string
}

/** Map backend trigger fields to frontend Trigger shape */
function mapRawTrigger(t: RawTrigger): Trigger {
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? undefined,
    enabled: t.enabled,
    is_active: t.enabled,
    query_text: t.condition_text,
    threshold: t.threshold,
    cooldown_minutes: typeof t.action_config?.cooldown_minutes === 'number' ? t.action_config.cooldown_minutes : undefined,
    delivery_channel: typeof t.action_config?.delivery_channel === 'string' ? t.action_config.delivery_channel : undefined,
    fire_count: t.trigger_count,
    last_fired_at: t.last_triggered_at ?? undefined,
    created_at: t.created_at,
  }
}

export const triggersApi = {
  list: async () => {
    // API returns { triggers: RawTrigger[] } — normalize and map fields to frontend Trigger shape
    const raw = await request<{ triggers: RawTrigger[] }>('/triggers')
    const data = (raw.triggers ?? []).map(mapRawTrigger)
    return { data }
  },

  get: async (id: string) => {
    const raw = await request<RawTrigger>(`/triggers/${id}`)
    return mapRawTrigger(raw)
  },

  create: (name: string, queryText: string) => {
    // Backend expects camelCase `queryText`, not snake_case `query_text`
    // Backend returns { trigger: RawTrigger }
    return request<{ trigger: RawTrigger }>('/triggers', {
      method: 'POST',
      body: JSON.stringify({ name, queryText }),
    }).then(res => mapRawTrigger(res.trigger))
  },

  toggle: (id: string, enabled: boolean) => {
    return request<Trigger>(`/triggers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  },

  delete: (id: string) => {
    return request<void>(`/triggers/${id}`, {
      method: 'DELETE',
    })
  },
}

// Admin API

// Slack channel types used by admin API

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

export interface AdminBanner {
  message: string
  level: 'info' | 'success' | 'warning'
  created_at: string
}

export const adminApi = {
  getBanner: () => {
    return request<{ banner: AdminBanner | null }>('/admin/banner')
  },

  resetData: () => {
    return request<{ cleared: string[]; preserved: string[]; wiped_at: string }>('/admin/reset-data', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'WIPE ALL DATA' }),
    })
  },

  clearQueue: (queueName: string, state: 'failed' | 'completed' | 'delayed' = 'failed') => {
    return request<{ queue: string; state: string; cleared_count: number; cleared_at: string }>(
      `/admin/queues/${encodeURIComponent(queueName)}/clear`,
      {
        method: 'POST',
        body: JSON.stringify({ state }),
      },
    )
  },

  /** List all Slack channels with activity metadata */
  getSlackChannels: () => {
    return request<{ channels: SlackChannel[] }>('/admin/slack/channels')
  },

  /** Archive a Slack channel by ID */
  archiveSlackChannel: (channelId: string) => {
    return request<{ ok: boolean; channel_id: string; archived_at: string }>(
      `/admin/slack/channels/${encodeURIComponent(channelId)}/archive`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    )
  },
}

// Settings API

export const settingsApi = {
  get: <T = unknown>(key: string) => {
    return request<{ key: string; value: T; updated_at: string }>(`/settings/${encodeURIComponent(key)}`)
  },

  put: <T = unknown>(key: string, value: T) => {
    return request<{ key: string; value: T; updated_at: string }>(`/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  },
}

// Pipeline API

export const pipelineApi = {
  health: () => {
    // Endpoint is under /admin/pipeline/health
    return request<PipelineHealth>('/admin/pipeline/health')
  },

  retry: (captureId: string) => {
    return request<{ success: boolean }>(`/pipeline/retry/${captureId}`, {
      method: 'POST',
    })
  },
}

// Intelligence API — daily-connections and drift-monitor skill results

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

export interface IntelligenceSummary {
  connections: IntelligenceEntry | null
  drift: IntelligenceEntry | null
}

export const intelligenceApi = {
  /** Fetch latest results for both daily-connections and drift-monitor in one call */
  summary: () => {
    return request<IntelligenceSummary>('/intelligence/summary')
  },

  /** Fetch latest daily-connections result */
  connectionsLatest: () => {
    return request<{ data: IntelligenceEntry | null }>('/intelligence/connections/latest')
  },

  /** Fetch daily-connections run history */
  connectionsHistory: (limit?: number) => {
    const qs = buildQueryString({ limit })
    return request<{ data: IntelligenceEntry[] }>(`/intelligence/connections/history${qs}`)
  },

  /** Fetch latest drift-monitor result */
  driftLatest: () => {
    return request<{ data: IntelligenceEntry | null }>('/intelligence/drift/latest')
  },

  /** Fetch drift-monitor run history */
  driftHistory: (limit?: number) => {
    const qs = buildQueryString({ limit })
    return request<{ data: IntelligenceEntry[] }>(`/intelligence/drift/history${qs}`)
  },

  /** Manually trigger an intelligence skill */
  trigger: (skill: 'daily-connections' | 'drift-monitor' | 'daily-sweep-skill', overrides?: Record<string, unknown>) => {
    return request<{ skill: string; job_id: string; status: string; message: string }>(
      `/intelligence/${skill}/trigger`,
      {
        method: 'POST',
        body: JSON.stringify(overrides ?? {}),
      },
    )
  },

  /** Fetch unresolved questions — questions with no entity-overlap follow-up in 7 days */
  unresolvedQuestions: (limit = 5) =>
    request<{ questions: Array<{ id: string; content: string; brain_view: string; created_at: string }>; count: number }>(
      `/intelligence/unresolved-questions?limit=${limit}`,
    ),
}

// Bets API — API uses statement/confidence/resolution; web uses description/status/due_date

interface RawBetRecord {
  id: string
  statement: string
  confidence: number
  domain: string | null
  resolution_date: string | null
  resolution: 'correct' | 'incorrect' | 'ambiguous' | 'pending' | null
  resolution_notes: string | null
  session_id: string | null
  created_at: string
  updated_at: string
}

const RESOLVED_VALUES = new Set(['correct', 'incorrect', 'ambiguous'])

function mapRawBet(b: RawBetRecord): Bet {
  const isResolved = b.resolution !== null && RESOLVED_VALUES.has(b.resolution)
  const status: Bet['status'] =
    b.resolution === 'correct' ? 'won' :
    b.resolution === 'incorrect' ? 'lost' :
    b.resolution === 'ambiguous' ? 'cancelled' :
    'open'
  return {
    id: b.id,
    description: b.statement,
    statement: b.statement,
    due_date: b.resolution_date ?? '',
    resolution_date: b.resolution_date ?? undefined,
    brain_view: 'technical' as Bet['brain_view'], // API doesn't store brain_view on bets
    status,
    outcome: b.resolution ?? undefined,
    created_at: b.created_at,
    resolved_at: isResolved ? b.updated_at : undefined,
  }
}

export const betsApi = {
  list: async (params?: { status?: string }) => {
    const qs = buildQueryString(params ?? {})
    // API returns { items, total } — map API fields to web Bet shape
    const raw = await request<{ items: RawBetRecord[]; total: number }>(`/bets${qs}`)
    const data = (raw.items ?? []).map(mapRawBet)
    return { data, total: raw.total }
  },

  get: async (id: string): Promise<Bet> => {
    const raw = await request<RawBetRecord>(`/bets/${id}`)
    return mapRawBet(raw)
  },

  create: (payload: { statement: string; confidence: number; due_date?: string }) => {
    return request<RawBetRecord>('/bets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then(mapRawBet)
  },

  resolve: (id: string, outcome: 'won' | 'lost' | 'cancelled') => {
    // Map web outcome to API resolution value
    const resolution =
      outcome === 'won' ? 'correct' :
      outcome === 'lost' ? 'incorrect' : 'ambiguous'
    return request<RawBetRecord>(`/bets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolution }),
    }).then(mapRawBet)
  },
}

// Wiki API

export const wikiApi = {
  /** List all wiki pages (metadata only, no content) */
  pages: (directory?: string) => {
    const qs = buildQueryString({ directory: directory ?? '' })
    return request<{ pages: WikiPageMeta[] }>(`/wiki/pages${qs}`)
      .then((r) => r.pages)
  },

  /** Get a single wiki page with full content */
  page: (pagePath: string) => {
    return request<WikiPageFull>(`/wiki/pages/${encodeURIComponent(pagePath)}`)
  },

  /** Get recent changes (git log) */
  recentChanges: (limit = 20) => {
    const qs = buildQueryString({ limit })
    return request<{ changes: WikiRecentChange[] }>(`/wiki/recent-changes${qs}`)
      .then((r) => r.changes)
  },

  /** Get the lint report */
  lintReport: () => {
    return request<WikiLintReport>('/wiki/lint-report')
  },

  /** Search wiki pages */
  search: (q: string) => {
    const qs = buildQueryString({ q })
    return request<{ pages: WikiPageMeta[] }>(`/wiki/search${qs}`)
      .then((r) => r.pages)
  },

  /** Trigger a wiki re-ingest for a specific capture */
  triggerIngest: (captureId: string) => {
    return request<{ job_id: string }>('/wiki/ingest', {
      method: 'POST',
      body: JSON.stringify({ capture_id: captureId }),
    })
  },

  /** Trigger the wiki lint skill */
  triggerLint: () => {
    return request<{ job_id: string }>('/wiki/lint', {
      method: 'POST',
    })
  },

  /** Trigger re-synthesis for a specific wiki page */
  triggerResynthesize: (pagePath: string) => {
    return request<{ job_id: string }>('/wiki/resynthesize', {
      method: 'POST',
      body: JSON.stringify({ page_path: pagePath }),
    })
  },
}

// Activity Feed API

export const activityApi = {
  /** Fetch paginated activity feed with optional filters */
  list: async (params?: {
    type?: string
    view?: string
    since?: string
    limit?: number
    offset?: number
  }) => {
    const qs = buildQueryString(params ?? {})
    return request<{ items: ActivityFeedItem[]; total: number; limit: number; offset: number }>(
      `/activity/feed${qs}`,
    )
  },

  /** Count items since a given ISO timestamp */
  countSince: async (since: string) => {
    const qs = buildQueryString({ since, limit: 0 })
    const res = await request<{ items: ActivityFeedItem[]; total: number; limit: number; offset: number }>(
      `/activity/feed${qs}`,
    )
    return res.total
  },
}

// System Health API

export const systemHealthApi = {
  /** GET /api/v1/system/health — full health snapshot (rich format with per-queue status, Redis memory, spend) */
  snapshot: () => {
    return request<SystemHealthData>('/system/health')
  },

  /** GET /api/v1/system/health — full snapshot with QueueStats array, Redis memory, monthly spend, skill runs */
  fullSnapshot: () => {
    return request<SystemHealthSnapshot>('/system/health')
  },

  /** GET /api/v1/system/infrastructure — container health, backup log, cost summary */
  infrastructure: () => {
    return request<InfrastructureData>('/system/infrastructure')
  },

  /** GET /api/v1/system/flows — recent pipeline flows with stage details */
  flows: (limit = 20) => {
    const qs = buildQueryString({ limit })
    return request<{ flows: PipelineFlowEntry[] }>(`/system/flows${qs}`)
  },

  /**
   * Build a SystemHealthData object from legacy endpoints when /system/health is unavailable.
   * Combines /health (services) + /admin/pipeline/health (queues).
   */
  fallbackSnapshot: async (): Promise<SystemHealthData> => {
    const [healthRes, pipelineRes] = await Promise.allSettled([
      request<{
        status: string
        services: Record<string, { status: string }>
      }>('/health'),
      pipelineApi.health(),
    ])

    const health = healthRes.status === 'fulfilled' ? healthRes.value : null
    const pipeline = pipelineRes.status === 'fulfilled' ? pipelineRes.value : null

    const queues = pipeline?.queues ?? {}
    let totalWaiting = 0
    let totalActive = 0
    let totalFailed = 0
    const byQueue: Record<string, { waiting: number; active: number; failed: number }> = {}

    for (const [name, q] of Object.entries(queues)) {
      const w = q.waiting ?? 0
      const a = q.active ?? 0
      const f = q.failed ?? 0
      byQueue[name] = { waiting: w, active: a, failed: f }
      totalWaiting += w
      totalActive += a
      totalFailed += f
    }

    return {
      status: (health?.status ?? 'unhealthy') as SystemHealthData['status'],
      timestamp: new Date().toISOString(),
      queues: {
        total_waiting: totalWaiting,
        total_active: totalActive,
        total_failed: totalFailed,
        by_queue: byQueue,
      },
      last_skill_run: null,
      llm_spend: { month_total_usd: 0, budget_usd: 10 },
      services: {
        postgres: { status: health?.services?.postgres?.status ?? 'unknown' },
        redis: { status: health?.services?.redis?.status ?? 'unknown' },
        llm: { status: health?.services?.llm?.status ?? 'unknown' },
      },
    }
  },
}

// MCP Activity API

export const mcpActivityApi = {
  /** GET /api/v1/mcp/activity — paginated MCP tool call log */
  list: (params?: { limit?: number; offset?: number; tool_name?: string; client_id?: string; since?: string }) => {
    const qs = buildQueryString(params ?? {})
    return request<{ items: McpActivityEntry[]; total: number; limit: number; offset: number }>(`/mcp/activity${qs}`)
  },
}

// Email Drafts API

export const emailApi = {
  /** List email drafts with optional status filter */
  list: async (params?: { status?: string; limit?: number; offset?: number }) => {
    const qs = buildQueryString(params ?? {})
    return request<{ items: EmailDraft[]; total: number; limit: number; offset: number }>(
      `/email/drafts${qs}`,
    )
  },

  /** Get a single email draft by ID */
  get: (id: string) => {
    return request<EmailDraft>(`/email/drafts/${id}`)
  },

  /** Create a new email draft */
  create: (payload: { to: string; subject: string; body: string; cc?: string; source?: string }) => {
    return request<EmailDraft>('/email/drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  /** Approve and send a draft */
  send: (id: string) => {
    return request<EmailDraft>(`/email/drafts/${id}/send`, {
      method: 'POST',
    })
  },

  /** Reject/discard a draft */
  reject: (id: string) => {
    return request<EmailDraft>(`/email/drafts/${id}`, {
      method: 'DELETE',
    })
  },
}

// Config API — read-only configuration and integration status

export const configApi = {
  /** GET /api/v1/config/ai-routing — model routing table + per-model monthly spend */
  aiRouting: () => {
    return request<AIRoutingResponse>('/config/ai-routing')
  },

  /** GET /api/v1/config/integrations — integration connectivity statuses */
  integrations: () => {
    return request<{ integrations: IntegrationStatus[] }>('/config/integrations')
  },
}

// Voice Sessions API

/** Raw voice session record as returned by the backend API */
interface RawVoiceSession {
  id: string
  session_key: string
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  turn_count: number | null
  transcript: Array<{ role: string; content: string; timestamp?: string }> | null
  summary: string | null
  captures_created: string[] | null
  metadata: Record<string, unknown> | null
  created_at: string
}

/** Map backend voice session fields to frontend VoiceSession shape */
function mapRawVoiceSession(raw: RawVoiceSession): VoiceSession {
  const captureIds = raw.captures_created ?? []
  return {
    id: raw.id,
    session_key: raw.session_key,
    started_at: raw.started_at,
    ended_at: raw.ended_at,
    duration_s: raw.duration_seconds,
    turn_count: raw.turn_count ?? 0,
    captures_created: captureIds.length,
    summary: raw.summary,
    transcript: (raw.transcript ?? []).map((t) => ({
      role: t.role as 'user' | 'assistant',
      text: t.content,
      timestamp: t.timestamp ?? raw.started_at,
    })),
    capture_ids: captureIds,
  }
}

export const voiceSessionApi = {
  /** GET /api/v1/voice/sessions — list all voice conversation sessions */
  list: async (params?: { limit?: number; offset?: number }) => {
    const qs = buildQueryString(params ?? {})
    const raw = await request<{ items: RawVoiceSession[]; total: number; limit: number; offset: number }>(
      `/voice/sessions${qs}`,
    )
    return {
      items: (raw.items ?? []).map(mapRawVoiceSession),
      total: raw.total,
      limit: raw.limit,
      offset: raw.offset,
    }
  },

  /** GET /api/v1/voice/sessions/active — get any active (in-progress) sessions */
  active: async () => {
    const raw = await request<{ items: RawVoiceSession[] }>('/voice/sessions/active')
    return { sessions: (raw.items ?? []).map(mapRawVoiceSession) }
  },

  /** GET /api/v1/voice/sessions/:id — get a single session with full transcript */
  get: async (id: string) => {
    const raw = await request<RawVoiceSession>(`/voice/sessions/${encodeURIComponent(id)}`)
    return mapRawVoiceSession(raw)
  },
}
