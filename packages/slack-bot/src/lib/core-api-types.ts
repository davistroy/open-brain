/**
 * Type definitions for the Open Brain Core API.
 * Extracted from core-api-client.ts (Phase 29) for reuse across the slack-bot package.
 */

export interface CreateCapturePayload {
  content: string
  capture_type: string
  brain_view: string
  source: string
  metadata?: {
    source_metadata?: Record<string, unknown>
    tags?: string[]
  }
}

export interface SearchPayload {
  query: string
  limit?: number
  offset?: number
  threshold?: number
  brain_views?: string[]
  temporal_weight?: number
  search_mode?: 'fts' | 'vector' | 'hybrid'
}

export interface PreExtracted {
  entities?: Array<{ name: string; type: string }>
  topics?: string[]
  sentiment?: string
}

export interface CaptureResult {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  pipeline_status: string
  tags: string[]
  created_at: string
  pre_extracted?: PreExtracted
}

export interface SearchResult {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  score: number
  created_at: string
  pre_extracted?: PreExtracted
}

export interface SearchResponse {
  query: string
  total: number
  results: SearchResult[]
}

export interface BrainStats {
  total_captures: number
  by_source: Record<string, number>
  by_type: Record<string, number>
  by_view: Record<string, number>
  pipeline_health: {
    pending: number
    processing: number
    complete: number
    failed: number
  }
}

export interface TriggerRecord {
  id: string
  name: string
  query_text: string
  threshold: number
  cooldown_minutes: number
  delivery_channel: string
  is_active: boolean
  fire_count: number
  last_fired_at: string | null
  created_at: string
}

/** A capture that matched a trigger test query */
export interface TriggerMatch {
  id: string
  content: string
  capture_type: string
  brain_view: string
  created_at: string
  similarity: number
}

export interface EntityRecord {
  id: string
  name: string
  type: string
  aliases: string[]
  capture_count: number
  last_seen_at?: string
  created_at?: string
}

export interface EntityMergeResult {
  message: string
  source_id: string
  target_id: string
}

export interface EntitySplitResult {
  message: string
  source_entity_id: string
  new_entity_id: string
  alias: string
}

export interface SessionRecord {
  id: string
  session_type: string
  status: string
  config: unknown | null
  summary: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface BetRecord {
  id: string
  statement: string
  confidence: number
  domain: string
  resolution_date: string | null
  resolution: string | null
  resolution_notes: string | null
  session_id: string | null
  created_at: string
  updated_at: string
}

export interface SynthesizePayload {
  query: string
  limit?: number
}

export interface SynthesizeResponse {
  response: string
}

export interface PipelineStatus {
  queues: Record<string, {
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
  }>
  overall: {
    pending: number
    processing: number
    complete: number
    failed: number
  }
}

export interface RecentCapture {
  id: string
  content: string
  capture_type: string
  brain_view: string
  source: string
  created_at: string
}

export interface SkillLastRun {
  skill_name: string
  status: string
  completed_at: string
  duration_ms: number
  captures_queried: number
  result_summary: string
}
