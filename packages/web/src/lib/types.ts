/**
 * Types for the Open Brain web dashboard
 */

export type CaptureType = 'decision' | 'idea' | 'observation' | 'task' | 'win' | 'blocker' | 'question' | 'reflection'
export type BrainView = 'career' | 'personal' | 'technical' | 'work-internal' | 'client'
export type CaptureSource = 'api' | 'slack' | 'voice' | 'document' | 'bookmark' | 'calendar'
export type PipelineStatus = 'pending' | 'processing' | 'complete' | 'partial' | 'failed'

export interface PreExtracted {
  entities?: Array<{ name: string; type: string; id?: string }>
  topics?: string[]
  sentiment?: string
}

export interface Capture {
  id: string
  content: string
  capture_type: CaptureType
  brain_view: BrainView
  source: CaptureSource
  pipeline_status: PipelineStatus
  tags?: string[]
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
  next_run?: string
}

export interface SkillLog {
  id: string
  skill_id: string
  skill_name: string
  status: 'running' | 'completed' | 'failed'
  started_at: string
  completed_at?: string
  output?: string
  error?: string
}

export interface Trigger {
  id: string
  name: string
  description: string
  enabled: boolean
  conditions: Record<string, unknown>
  actions: Record<string, unknown>
  created_at: string
}

export interface Bet {
  id: string
  description: string
  due_date: string
  brain_view: BrainView
  status: 'open' | 'won' | 'lost' | 'cancelled'
  outcome?: string
  created_at: string
  resolved_at?: string
}

export interface PipelineHealth {
  queues: {
    ingestion: QueueHealth
    embedding: QueueHealth
    extraction: QueueHealth
  }
  stale_count: number
  last_check: string
}

export interface QueueHealth {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}
