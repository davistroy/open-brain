/**
 * Intelligence API namespace. Extracted from `lib/api-client.ts` (Phase 8a Round 2).
 *
 * Exports: `intelligenceApi`, `IntelligenceEntry`, `IntelligenceSummaryResponse`
 */

import { request, buildQueryString } from './core'

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
