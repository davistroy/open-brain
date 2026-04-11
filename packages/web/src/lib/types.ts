/**
 * Types for the Open Brain web dashboard
 */

export type AutonomyLevel = 'observe' | 'assist' | 'advise' | 'partner'

export type CaptureType = 'decision' | 'idea' | 'observation' | 'task' | 'win' | 'blocker' | 'question' | 'reflection'
export type BrainView = 'career' | 'personal' | 'technical' | 'work-internal' | 'client'
export type CaptureSource = 'api' | 'slack' | 'voice' | 'document' | 'mcp' | 'email'
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
  query?: string
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

export interface SynthesisResult {
  response: string
  capture_count: number
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

// ─── Wiki types ──────────────────────────────────────────────────────────────

export type WikiPageType = 'entity' | 'concept' | 'source' | 'comparison' | 'synthesis' | 'overview'

export interface WikiPageMeta {
  path: string
  title: string
  type: WikiPageType
  created: string
  updated: string
  source_count?: number
  tags?: string[]
  aliases?: string[]
}

export interface WikiPageFull extends WikiPageMeta {
  content: string
}

export interface WikiRecentChange {
  hash: string
  date: string
  message: string
  files: string[]
}

export interface WikiLintIssue {
  page: string
  severity: 'error' | 'warning' | 'info'
  message: string
  rule: string
}

export interface WikiLintReport {
  total_pages: number
  issues: WikiLintIssue[]
  last_run?: string
}

// ─── Activity feed ──────────────────────────────────────────────────────────

export type ActivityType = 'capture' | 'skill' | 'pipeline' | 'entity' | 'wiki' | 'mcp' | 'system'

export interface ActivityFeedItem {
  id: string
  type: ActivityType
  subtype: string | null
  timestamp: string
  summary: string
  view: string | null
  detail: Record<string, unknown> | null
  source_id: string | null
  created_at: string
}

// ─── MCP activity ───────────────────────────────────────────────────────────

export interface McpActivityEntry {
  id: string
  timestamp: string
  client_id: string | null
  tool_name: string
  parameters: Record<string, unknown> | null
  result_summary: string | null
  duration_ms: number | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// ─── System health ───────────────────────────────────────────────────────────

/** System health snapshot from GET /api/v1/system/health */
export interface SystemHealthData {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  queues: {
    total_waiting: number
    total_active: number
    total_failed: number
    by_queue: Record<string, { waiting: number; active: number; failed: number }>
  }
  last_skill_run: {
    name: string
    status: string
    completed_at: string
  } | null
  llm_spend: {
    month_total_usd: number
    budget_usd: number
  }
  services: {
    postgres: { status: string }
    redis: { status: string }
    llm: { status: string }
  }
}

/** Full system health snapshot — matches backend SystemHealthSnapshot shape */
export interface SystemHealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  uptime_s: number
  queues: QueueStatsEntry[]
  redis_memory: {
    used_bytes: number
    max_bytes: number
    used_pct: number
    status: 'healthy' | 'degraded' | 'unhealthy'
  }
  monthly_spend: {
    month: string
    total_usd: number
    non_claude_usd: number
    status: 'healthy' | 'degraded' | 'unhealthy'
  }
  skill_last_runs: SkillLastRun[]
}

export interface QueueStatsEntry {
  name: string
  waiting: number
  active: number
  failed: number
  delayed: number
  status: 'healthy' | 'degraded' | 'unhealthy'
}

export interface SkillLastRun {
  skill_name: string
  last_run_at: string
  duration_ms: number | null
  output_summary: string | null
}

// ─── Config / AI Routing ─────────────────────────────────────────────────────

export interface ModelRoutingEntry {
  task: string
  model: string
  client: 'anthropic' | 'litellm'
  cost_per_1k_input: number
  cost_per_1k_output: number
  month_spend_usd: number
  month_calls: number
}

export interface AIRoutingResponse {
  models: ModelRoutingEntry[]
  budget: {
    soft_limit_usd: number
    hard_limit_usd: number
    month_total_usd: number
  }
}

// ─── Integrations ────────────────────────────────────────────────────────────

export interface IntegrationStatus {
  name: string
  status: 'connected' | 'disconnected' | 'unknown'
  url?: string
  detail?: string
  last_activity?: string
}
