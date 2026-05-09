/**
 * TanStack Query hooks — settings domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['settings', key]   — single app_settings value by key
 *
 * Note: `staleTime: 60_000` is the existing convention across all settings
 * consumers. Kept here so migrated components get identical cache behaviour
 * without having to re-specify it.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { settingsApi } from './settings'

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Read a single setting by key.
 * Skips the fetch when key is empty.
 * Returns the typed `SettingEntry` (`{ key, value, updated_at }`).
 */
export function useSetting(key: string) {
  return useQuery({
    queryKey: ['settings', key],
    queryFn: () => settingsApi.get(key),
    enabled: Boolean(key),
    staleTime: 60_000,
  })
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Write a setting value.
 * On success, updates the cache entry for that key directly (no refetch needed)
 * so the toggle/slider reflects the new value instantly.
 */
export function usePutSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      settingsApi.put(key, value),
    onSuccess: (result) => {
      qc.setQueryData(['settings', result.key], result)
    },
  })
}
