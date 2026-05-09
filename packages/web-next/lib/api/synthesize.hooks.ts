'use client';

/**
 * TanStack Query hooks for the synthesize domain.
 *
 * Hook barrel — NOT re-exported from lib/api/index.ts (barrel is used in RSC context;
 * hooks import @tanstack/react-query which must stay client-component-only).
 * Consumers import directly: `import { useSynthesizeQuery } from '@/lib/api/synthesize.hooks'`
 */

import { useQuery } from '@tanstack/react-query';
import { synthesizeApi } from './synthesize';
import type { SynthesizePayload } from './synthesize';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const synthesizeKeys = {
  query: (query: string) => ['synthesize', query] as const,
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/synthesize — LLM synthesis over matching captures.
 *
 * Special options:
 *   - `enabled`: pass false or `!shouldSynthesize` to skip the query
 *   - `retry: false` (synthesis is expensive — don't auto-retry on failure)
 *   - `refetchOnWindowFocus: false` (synthesis answers are stable)
 *   - `staleTime: 120_000` (2 min — synthesis is expensive)
 */
export function useSynthesizeQuery(
  payload: SynthesizePayload,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: synthesizeKeys.query(payload.query),
    queryFn: () => synthesizeApi.query(payload),
    enabled: options?.enabled !== false && Boolean(payload.query.trim()),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 120_000,
  });
}
