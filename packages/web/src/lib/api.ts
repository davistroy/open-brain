/**
 * API client for Open Brain Core API
 */

import type { Capture, BrainStats, SearchFilters, SearchResult, Entity, Skill, SkillLog, Trigger, Bet, PipelineHealth } from './types'

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
  search: (filters: SearchFilters) => {
    return request<SearchResult>('/search', {
      method: 'POST',
      body: JSON.stringify(filters),
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

  trigger: (skillName: string) => {
    return request<{ job_id: string }>(`/skills/${skillName}/trigger`, {
      method: 'POST',
      body: JSON.stringify({}),
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

export const triggersApi = {
  list: async () => {
    // API returns { triggers: TriggerRecord[] } — normalize to { data: Trigger[] }
    const raw = await request<{ triggers: Trigger[] }>('/triggers')
    return { data: raw.triggers ?? [] }
  },

  get: (id: string) => {
    return request<Trigger>(`/triggers/${id}`)
  },

  create: (name: string, queryText: string) => {
    return request<Trigger>('/triggers', {
      method: 'POST',
      body: JSON.stringify({ name, query_text: queryText }),
    })
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

export const adminApi = {
  resetData: () => {
    return request<{ cleared: string[]; preserved: string[]; wiped_at: string }>('/admin/reset-data', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'WIPE ALL DATA' }),
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
