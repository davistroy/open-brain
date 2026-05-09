/**
 * TanStack Query hooks — voice domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['voice-sessions']          — paginated session list
 *   ['voice-sessions-active']   — active sessions (no ended_at)
 *   ['voice-session', id]       — single session with full transcript
 *
 * Note: VoiceConversationsClient, SessionList, SessionDetail, and
 * VoiceSection all use these keys. Keep them stable — components share
 * cache entries when using the same key.
 */

import { useQuery } from '@tanstack/react-query'
import { voiceSessionApi } from './voice'
import type { VoiceSessionsListParams } from './voice'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Paginated voice session list.
 * Supports `initialData` for RSC pre-fetch.
 */
export function useVoiceSessions(
  params: VoiceSessionsListParams = {},
  options?: { initialData?: Awaited<ReturnType<typeof voiceSessionApi.list>> },
) {
  return useQuery({
    queryKey: ['voice-sessions'],
    queryFn: () => voiceSessionApi.list(params),
    initialData: options?.initialData,
  })
}

/**
 * Active voice sessions (no ended_at).
 * Polled on the conversations page to detect live sessions.
 */
export function useActiveVoiceSessions() {
  return useQuery({
    queryKey: ['voice-sessions-active'],
    queryFn: () => voiceSessionApi.active(),
  })
}

/**
 * Single voice session with full transcript.
 * Skips fetch when id is falsy.
 * Active sessions re-fetch every 10 seconds to pick up new transcript turns.
 */
export function useVoiceSession(id: string, options?: { isActive?: boolean }) {
  return useQuery({
    queryKey: ['voice-session', id],
    queryFn: () => voiceSessionApi.get(id),
    enabled: Boolean(id),
    refetchInterval: options?.isActive ? 10_000 : false,
  })
}
