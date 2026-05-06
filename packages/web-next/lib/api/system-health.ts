/**
 * systemHealthApi — /api/v1/system/* operational metrics
 *
 * Extracted from api-client.ts (lines 1155-1284). Covers the system health,
 * pipeline flow, and infrastructure endpoints. NOT to be confused with
 * serviceHealthApi (/api/v1/health) — that is a separate domain.
 */

import { request, buildQueryString } from './core'

// ---------------------------------------------------------------------------
// Types
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

// ---------------------------------------------------------------------------
// API namespace
// ---------------------------------------------------------------------------

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
