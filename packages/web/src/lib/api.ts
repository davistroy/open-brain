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

export const entitiesApi = {
  list: async (params?: { type?: string; sort?: string; limit?: number }) => {
    const qs = buildQueryString(params ?? {})
    // API returns { items, total } — normalize to { data, total }
    // API uses entity_type (not type) and mention_count (not capture_count)
    type RawEntity = Omit<Entity, 'type' | 'capture_count' | 'first_seen' | 'last_seen'> & {
      entity_type: string; mention_count: number; first_seen_at?: string; last_seen_at?: string
    }
    const raw = await request<{ items: RawEntity[]; total: number }>(`/entities${qs}`)
    const data = (raw.items ?? []).map(e => ({
      ...e,
      type: e.entity_type as Entity['type'],
      capture_count: e.mention_count,
      first_seen: e.first_seen_at ?? '',
      last_seen: e.last_seen_at ?? '',
    }))
    return { data, total: raw.total }
  },

  get: (id: string) => {
    return request<Entity & { captures: Capture[] }>(`/entities/${id}`)
  },

  getCaptures: (id: string) => {
    return request<{ data: Capture[] }>(`/entities/${id}/captures`)
  },

  merge: (sourceIds: string | string[], targetName: string) => {
    const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds]
    return request<{ merged_entity_id: string; merged_count: number }>('/entities/merge', {
      method: 'POST',
      body: JSON.stringify({ source_ids: ids, target_name: targetName }),
    })
  },

  split: (entityId: string, newNames: string | string[]) => {
    const names = Array.isArray(newNames) ? newNames : [newNames]
    return request<Entity>(`/entities/${entityId}/split`, {
      method: 'POST',
      body: JSON.stringify({ new_names: names }),
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

// Bets API

export const betsApi = {
  list: async (params?: { status?: string }) => {
    const qs = buildQueryString(params ?? {})
    // API returns { items, total } — normalize to { data, total }
    const raw = await request<{ items: Bet[]; total: number }>(`/bets${qs}`)
    return { data: raw.items ?? [], total: raw.total }
  },

  get: (id: string) => {
    return request<Bet>(`/bets/${id}`)
  },

  create: (payload: { description: string; due_date: string; brain_view: string }) => {
    return request<Bet>('/bets', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  resolve: (id: string, outcome: string) => {
    return request<Bet>(`/bets/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome }),
    })
  },
}
