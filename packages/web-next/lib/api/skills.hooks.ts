/**
 * TanStack Query hooks — skills domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['skills', 'list']         — full skill list with last-run metadata
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { skillsApi, skillsListApi } from './skills'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Full list of configured skills with last-run metadata.
 * `staleTime: 120_000` — skills list changes infrequently (schedule edits only).
 */
export function useSkillsList() {
  return useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => skillsListApi.list(),
    staleTime: 120_000,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Manually trigger a skill by name. Fire-and-forget — no cache invalidation. */
export function useTriggerSkill() {
  return useMutation({
    mutationFn: ({ name, params = {} }: { name: string; params?: Record<string, unknown> }) =>
      skillsApi.trigger(name, params),
  })
}

/** Update a skill's cron schedule. Invalidates the skills list on success. */
export function useUpdateSkillSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, schedule }: { name: string; schedule: string }) =>
      skillsListApi.updateSchedule(name, schedule),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] })
    },
  })
}
