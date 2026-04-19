export type CaptureType =
  | 'decision'
  | 'idea'
  | 'observation'
  | 'task'
  | 'win'
  | 'blocker'
  | 'question'
  | 'reflection'

export type CaptureSource = 'slack' | 'voice' | 'api' | 'document' | 'mcp' | 'email' | 'file' | 'consolidation' | 'system'

/**
 * Pipeline lifecycle status for a capture row. Canonical 8-value set
 * (P09a / migration 0024 / issue #119). Lockstep across 4 surfaces:
 *
 *   - This TS union (canonical source of truth)
 *   - Zod enum: PIPELINE_STATUSES in packages/core-api/src/schemas/capture.ts
 *   - DB CHECK: captures_pipeline_status_check (migration 0024)
 *   - Drift guard: packages/shared/src/__tests__/web-type-drift.test.ts
 *   - Web redeclaration: PipelineStatus in packages/web/src/lib/types.ts
 *
 * Semantics:
 *   - `pending`     — newly written; awaits ingestion
 *   - `processing`  — ingestion-worker / document-pipeline picked it up
 *   - `extracted`   — entities extracted, awaiting embed (transient; cold-path
 *                     in current code, but historical rows persist)
 *   - `embedded`    — vector written, awaiting completion
 *   - `chunked`     — multi-chunk document parent; chunks are separate captures
 *                     (set by document-pipeline.ts when chunks.length > 1)
 *   - `complete`    — terminal success
 *   - `failed`      — terminal failure
 *   - `deleted`     — soft-deleted tombstone (deleted_at IS NOT NULL)
 *
 * Adding a value → update all four surfaces in lockstep AND run a pre-flight
 * `SELECT DISTINCT pipeline_status` audit on production before tightening.
 * ALSO grep production code for `? '<value>' :` ternary expressions — the
 * planner's keyed-property grep misses ternaries (caught `chunked` in P09a).
 */
export type PipelineStatus =
  | 'pending'
  | 'processing'
  | 'extracted'
  | 'embedded'
  | 'chunked'
  | 'complete'
  | 'failed'
  | 'deleted'

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
  pipeline_status?: PipelineStatus
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
  pipeline_status: PipelineStatus
  pipeline_attempts: number
  pipeline_error?: string
  pipeline_completed_at?: Date
  pre_extracted?: PreExtracted
  created_at: Date
  updated_at: Date
  captured_at: Date
  deleted_at?: Date | null
}
