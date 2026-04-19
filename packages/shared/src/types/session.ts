/**
 * Session lifecycle status.
 * Canonical 4-value set (P09c / migration 0026 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: sessions_status_check (migration 0026)
 *   - Route validation: VALID_STATUSES array in packages/core-api/src/routes/sessions.ts
 *
 * Semantics:
 *   - `active`    -- session in progress, accepting respond() calls
 *   - `paused`    -- session paused (up to 30 days); resumable via resume()
 *   - `complete`  -- terminal success; summary generated and captured
 *   - `abandoned` -- terminal failure/cancel; no summary generated
 *
 * Adding a value -> update BOTH surfaces (TS union + DB CHECK) in lockstep.
 */
export type SessionStatus = 'active' | 'paused' | 'complete' | 'abandoned'

/**
 * Session type -- the category of governance or review session.
 * Canonical 3-value set (P09c / migration 0026 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: sessions_session_type_check (migration 0026)
 *   - Route validation: VALID_TYPES array in packages/core-api/src/routes/sessions.ts
 *
 * Adding a value -> update BOTH surfaces (TS union + DB CHECK) in lockstep.
 * ALSO run a pre-flight SELECT DISTINCT audit before tightening.
 */
export type SessionType = 'governance' | 'review' | 'planning'

export interface TranscriptEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: string // ISO 8601
}

export interface SessionConfig {
  type: SessionType
  max_turns?: number        // default 20
  timeout_ms?: number       // default 30 minutes
  focus_brain_views?: string[] // which brain views to pull context from
}

export interface SessionState {
  id: string
  type: SessionType
  status: SessionStatus
  transcript: TranscriptEntry[]
  context_capture_ids: string[]  // captures used as context
  config: SessionConfig
  created_at: Date
  updated_at: Date
}
