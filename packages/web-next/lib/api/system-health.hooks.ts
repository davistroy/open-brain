/**
 * TanStack Query hooks — system-health domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['system', 'health']          — full operational snapshot (queues, redis, spend, skills, wiki)
 *   ['system', 'flows', limit?]   — recent pipeline flow entries
 *   ['system', 'infrastructure']  — container health, backups, cost
 *
 * Note: WikiSection uses `['system', 'health']` as its query key for
 * systemHealthApi.snapshot() — keep that key stable.
 */

import { useQuery } from '@tanstack/react-query'
import { systemHealthApi } from './system-health'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Full operational health snapshot. Skips automated refetch — manual refresh on system page. */
export function useSystemHealthSnapshot() {
  return useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => systemHealthApi.snapshot(),
    staleTime: 30_000,
  })
}

/** Recent pipeline flow entries. */
export function useSystemFlows(limit = 20) {
  return useQuery({
    queryKey: ['system', 'flows', limit],
    queryFn: () => systemHealthApi.flows(limit),
    staleTime: 30_000,
  })
}

/** Infrastructure data — container health, backups, LLM cost. */
export function useSystemInfrastructure() {
  return useQuery({
    queryKey: ['system', 'infrastructure'],
    queryFn: () => systemHealthApi.infrastructure(),
    staleTime: 30_000,
  })
}
