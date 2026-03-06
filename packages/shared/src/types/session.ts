export type SessionStatus = 'active' | 'paused' | 'complete' | 'abandoned'
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
