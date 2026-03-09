/**
 * Types for the Open Brain web dashboard
 */

export type CaptureType = 'decision' | 'idea' | 'observation' | 'task' | 'win' | 'blocker' | 'question' | 'reflection'
export type BrainView = 'career' | 'personal' | 'technical' | 'work-internal' | 'client'
export type CaptureSource = 'api' | 'slack' | 'voice' | 'document' | 'bookmark' | 'calendar' | 'mcp' | 'system'
export type PipelineStatus = 'pending' | 'processing' | 'complete' | 'partial' | 'failed'

export interface PreExtracted {
  entities?: Array<{ name: string; type: string; id?: string }>
  topics?: string[]
  sentiment?: string
}

export interface PipelineEvent {
  stage: string
  status: string
  duration_ms?: number
  error?: string
  started_at?: string
}

export interface CaptureEntity {
  id: string
  name: string
  type: string
}

export interface Capture {
  id: string
  content: string
  capture_type: CaptureType
  brain_view: BrainView
  source: CaptureSource
  pipeline_status: PipelineStatus
  tags?: string[]
  topics?: string[]
  entities?: CaptureEntity[]
  pipeline_events?: PipelineEvent[]
  source_metadata?: Record<string, unknown>
  similarity?: number
  created_at: string
  updated_at?: string
  embedding?: number[]
  pre_extracted?: PreExtracted
  metadata?: Record<string, unknown>
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

export interface SearchFilters {
  q?: string
  capture_type?: CaptureType
  brain_view?: BrainView
  source?: CaptureSource
  hybrid?: boolean
  threshold?: number
  limit?: number
  offset?: number
  start_date?: string
  end_date?: string
}

export interface SearchResult {
  captures: Capture[]
  total: number
  query: string
  hybrid: boolean
}

export interface Entity {
  id: string
  name: string
  type: 'person' | 'organization' | 'project' | 'location' | 'concept'
  aliases: string[]
  capture_count: number
  mention_count?: number
  first_seen: string
  last_seen: string
  captures?: Capture[]
}

export interface Skill {
  id: string
  name: string
  description: string
  enabled: boolean
  schedule?: string
  last_run?: string
  last_run_at?: string
  last_run_status?: string
  next_run?: string
  next_run_at?: string
}

export interface SkillLog {
  id: string
  skill_id: string
  skill_name: string
  status: string
  started_at: string
  completed_at?: string
  output?: string
  error?: string
  result?: Record<string, unknown>
  duration_ms?: number
  model_used?: string
  input_tokens?: number
  output_tokens?: number
}

export interface Trigger {
  id: string
  name: string
  description?: string
  enabled: boolean
  is_active?: boolean
  query_text?: string
  delivery_channel?: string
  threshold?: number
  cooldown_minutes?: number
  fire_count?: number
  last_fired_at?: string
  conditions?: Record<string, unknown>
  actions?: Record<string, unknown>
  created_at: string
}

export interface Bet {
  id: string
  description: string
  statement?: string
  rationale?: string
  due_date: string
  resolution_date?: string
  brain_view: BrainView
  status: 'open' | 'won' | 'lost' | 'cancelled'
  outcome?: string
  tags?: string[]
  created_at: string
  resolved_at?: string
}

export interface PipelineHealth {
  queues: Record<string, QueueHealth>
  stale_count?: number
  last_check?: string
}

export interface QueueHealth {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}
