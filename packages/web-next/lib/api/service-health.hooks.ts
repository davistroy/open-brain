'use client';

/**
 * TanStack Query hooks for the service-health domain.
 *
 * Wraps serviceHealthApi (GET /api/v1/health — lightweight dependency check).
 * NOT to be confused with system-health.hooks.ts (/api/v1/system/*).
 *
 * Hook barrel — NOT re-exported from lib/api/index.ts (barrel is used in RSC context;
 * hooks import @tanstack/react-query which must stay client-component-only).
 * Consumers import directly: `import { useServiceHealth } from '@/lib/api/service-health.hooks'`
 */

import { useQuery } from '@tanstack/react-query';
import { serviceHealthApi } from './service-health';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const SERVICE_HEALTH_QUERY_KEY = ['service-health'] as const;
export const VERSION_UPTIME_QUERY_KEY = ['settings', 'version-uptime'] as const;

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/health — lightweight dependency check (postgres, redis, llm).
 * staleTime: 30s. Used by ServiceHealthSection.
 */
export function useServiceHealth() {
  return useQuery({
    queryKey: SERVICE_HEALTH_QUERY_KEY,
    queryFn: () => serviceHealthApi.get(),
    staleTime: 30_000,
  });
}

/**
 * GET /api/v1/health — same endpoint, different query key for version + uptime display.
 * staleTime: 30s. refetchInterval: 60s (uptime counter stays reasonably current).
 * Used by VersionUptimeSection.
 */
export function useVersionUptime() {
  return useQuery({
    queryKey: VERSION_UPTIME_QUERY_KEY,
    queryFn: () => serviceHealthApi.get(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
