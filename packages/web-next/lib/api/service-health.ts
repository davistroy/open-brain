/**
 * serviceHealthApi — /api/v1/health (lightweight dependency check)
 *
 * Extracted from api-client.ts (lines 1653-1687). Covers the simple
 * postgres/redis/llm dependency health endpoint. NOT to be confused with
 * systemHealthApi (/api/v1/system/*) — that is a separate domain in system-health.ts.
 * HealthResponse is also used by VersionUptimeSection (consolidates HealthInfo).
 */

import { request } from './core'
import type { ServiceHealthStatus } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One service dependency check result from GET /api/v1/health. */
export interface ServiceCheck {
  status: ServiceHealthStatus
  latency_ms?: number
  error?: string
}

/**
 * Full health response from GET /api/v1/health.
 * Used by both ServiceHealthSection and VersionUptimeSection.
 * Consolidates the local HealthInfo interface from VersionUptimeSection.
 */
export interface HealthResponse {
  status: ServiceHealthStatus
  timestamp: string
  version?: string
  uptime_s?: number
  services: Record<string, ServiceCheck>
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const serviceHealthApi = {
  /**
   * GET /api/v1/health — lightweight dependency health check.
   * Returns HealthResponse { status, timestamp, version?, uptime_s?, services }.
   */
  get: (): Promise<HealthResponse> => request<HealthResponse>('/health'),
}
