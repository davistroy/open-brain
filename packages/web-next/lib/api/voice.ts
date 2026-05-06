/**
 * Voice session API client — GET /api/v1/voice/sessions
 *
 * Extracted from lib/api-client.ts. Import from `@/lib/api-client` for
 * the public barrel; import directly only within other `lib/api/*.ts` files.
 */

import { request, buildQueryString } from './core'
import type { ListEnvelope } from './core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Transcript turn as returned by the voice session API */
export interface TranscriptTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

/** Voice session record as returned by GET /api/v1/voice/sessions */
export interface VoiceSession {
  id: string
  session_key: string
  started_at: string         // ISO 8601
  ended_at: string | null    // null if session is still active
  duration_seconds: number | null
  turn_count: number | null
  transcript: TranscriptTurn[]
  summary: string | null
  captures_created: string[] // array of capture IDs linked to this session
  metadata: Record<string, unknown> | null
  created_at: string         // ISO 8601
}

export interface VoiceSessionsListParams {
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// voiceSessionApi
// ---------------------------------------------------------------------------

export const voiceSessionApi = {
  /**
   * GET /api/v1/voice/sessions — paginated list of voice sessions,
   * ordered by started_at DESC.
   */
  list: (params: VoiceSessionsListParams = {}): Promise<ListEnvelope<VoiceSession>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<VoiceSession>>(`/voice/sessions${qs}`)
  },

  /**
   * GET /api/v1/voice/sessions/active — sessions with no ended_at.
   * Returns { items: VoiceSession[] } (not a paginated envelope).
   */
  active: (): Promise<{ items: VoiceSession[] }> => {
    return request<{ items: VoiceSession[] }>('/voice/sessions/active')
  },

  /**
   * GET /api/v1/voice/sessions/:id — single session with full transcript.
   */
  get: (id: string): Promise<VoiceSession> => {
    return request<VoiceSession>(`/voice/sessions/${encodeURIComponent(id)}`)
  },
}
