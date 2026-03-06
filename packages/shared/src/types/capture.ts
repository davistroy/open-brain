export type CaptureType =
  | 'decision'
  | 'idea'
  | 'observation'
  | 'task'
  | 'win'
  | 'blocker'
  | 'question'
  | 'reflection'

export type CaptureSource = 'slack' | 'voice' | 'api' | 'document' | 'mcp'

// BrainView is a string — validated against config at runtime, not a hardcoded enum
export type BrainView = string

export interface SourceMetadata {
  channel?: string
  user?: string
  team?: string
  timestamp?: string
  file_path?: string
  url?: string
  [key: string]: unknown
}

export interface PreExtracted {
  entities?: Array<{ name: string; type: string }>
  topics?: string[]
  sentiment?: 'positive' | 'negative' | 'neutral'
}

export interface CaptureMetadata {
  source_metadata?: SourceMetadata
  tags?: string[]
  pre_extracted?: PreExtracted
  captured_at?: string // ISO 8601
}

export interface CreateCaptureInput {
  content: string
  capture_type: CaptureType
  brain_view: BrainView
  source: CaptureSource
  metadata?: CaptureMetadata
}

export interface CaptureFilter {
  brain_view?: BrainView
  capture_type?: CaptureType
  source?: CaptureSource
  tags?: string[]
  date_from?: Date
  date_to?: Date
  pipeline_status?: string
}

export interface CaptureRecord {
  id: string
  content: string
  content_hash: string
  capture_type: CaptureType
  brain_view: BrainView
  source: CaptureSource
  source_metadata?: SourceMetadata
  tags: string[]
  embedding?: number[]
  pipeline_status: string
  pipeline_attempts: number
  pipeline_error?: string
  pipeline_completed_at?: Date
  pre_extracted?: PreExtracted
  created_at: Date
  updated_at: Date
  captured_at: Date
  deleted_at?: Date | null
}
