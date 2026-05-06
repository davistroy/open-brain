/**
 * Stats API — aggregate capture statistics.
 * Split from `lib/api-client.ts`; import from `@/lib/api-client` for the
 * public barrel, or directly from this module for tree-shaking.
 */

import { request } from './core'

// ---------------------------------------------------------------------------
// Response types
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

// ---------------------------------------------------------------------------
// statsApi
// ---------------------------------------------------------------------------

export const statsApi = {
  /** GET /api/v1/stats — aggregate capture statistics */
  get: (): Promise<StatsResponse> => {
    return request<StatsResponse>('/stats')
  },
}
