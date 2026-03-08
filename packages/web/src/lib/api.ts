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
  list: (params?: { limit?: number; offset?: number; source?: string; capture_type?: string; brain_view?: string }) => {
    const qs = buildQueryString(params ?? {})
    return request<{ data: Capture[]; total: number; limit: number; offset: number }>(`/captures${qs}`)
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
  list: (params?: { type?: string; sort?: string; limit?: number }) => {
    const qs = buildQueryString(params ?? {})
    return request<{ data: Entity[]; total: number }>(`/entities${qs}`)
  },

  get: (id: string) => {
    return request<Entity & { captures: Capture[] }>(`/entities/${id}`)
  },

  merge: (sourceIds: string[], targetName: string) => {
    return request<{ merged_entity_id: string; merged_count: number }>('/entities/merge', {
      method: 'POST',
      body: JSON.stringify({ source_ids: sourceIds, target_name: targetName }),
    })
  },

  split: (entityId: string, newNames: string[]) => {
    return request<{ new_entities: string[] }>(`/entities/${entityId}/split`, {
      method: 'POST',
      body: JSON.stringify({ new_names: newNames }),
    })
  },
}

// Skills API

export const skillsApi = {
  list: () => {
    return request<Skill[]>('/skills')
  },

  run: (skillName: string, params?: Record<string, unknown>) => {
    return request<{ job_id: string }>(`/skills/${skillName}/run`, {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    })
  },

  logs: (skillName: string) => {
    return request<SkillLog[]>(`/skills/${skillName}/logs`)
  },

  latestBrief: () => {
    return request<{ id: string; content: string; created_at: string } | null>('/briefs/latest')
  },
}

// Triggers API

export const triggersApi = {
  list: () => {
    return request<Trigger[]>('/triggers')
  },

  get: (id: string) => {
    return request<Trigger>(`/triggers/${id}`)
  },

  toggle: (id: string, enabled: boolean) => {
    return request<Trigger>(`/triggers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  },
}

// Pipeline API

export const pipelineApi = {
  health: () => {
    return request<PipelineHealth>('/pipeline/health')
  },

  retry: (captureId: string) => {
    return request<{ success: boolean }>(`/pipeline/retry/${captureId}`, {
      method: 'POST',
    })
  },
}

// Bets API

export const betsApi = {
  list: (params?: { status?: string }) => {
    const qs = buildQueryString(params ?? {})
    return request<{ data: Bet[]; total: number }>(`/bets${qs}`)
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
