/**
 * TanStack Query hooks — intelligence domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['intelligence', 'summary']                 — connections + drift latest summary
 *   ['intelligence', 'connections', 'latest']   — latest connections entry
 *   ['intelligence', 'drift', 'latest']         — latest drift entry
 *   ['intelligence', 'unresolved-questions']    — open questions list
 */

import { useQuery, useMutation } from '@tanstack/react-query'
import { intelligenceApi } from './intelligence'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Latest intelligence summary (connections + drift in one request). */
export function useIntelligenceSummary() {
  return useQuery({
    queryKey: ['intelligence', 'summary'],
    queryFn: () => intelligenceApi.summary(),
  })
}

/** Latest daily-connections skill result. */
export function useConnectionsLatest() {
  return useQuery({
    queryKey: ['intelligence', 'connections', 'latest'],
    queryFn: () => intelligenceApi.connectionsLatest(),
  })
}

/** Latest drift-monitor skill result. */
export function useDriftLatest() {
  return useQuery({
    queryKey: ['intelligence', 'drift', 'latest'],
    queryFn: () => intelligenceApi.driftLatest(),
  })
}

/** Unresolved questions from captures. */
export function useUnresolvedQuestions(limit = 5) {
  return useQuery({
    queryKey: ['intelligence', 'unresolved-questions', limit],
    queryFn: () => intelligenceApi.unresolvedQuestions(limit),
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Manually trigger an intelligence skill.
 * Fire-and-forget — results arrive asynchronously via the skill queue.
 * No cache invalidation here; callers poll or use SSE for updates.
 */
export function useTriggerIntelligence() {
  return useMutation({
    mutationFn: ({
      skill,
      overrides = {},
    }: {
      skill: 'daily-connections' | 'drift-monitor' | 'daily-sweep-skill'
      overrides?: Record<string, unknown>
    }) => intelligenceApi.trigger(skill, overrides),
  })
}
