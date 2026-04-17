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

export type ActivityType = 'capture' | 'skill' | 'pipeline' | 'entity' | 'wiki' | 'mcp' | 'system' | 'email'

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

// ─── Infrastructure ────────────────────────────────────────────────────────

export interface ContainerHealthEntry {
  id: string
  timestamp: string
  container_name: string
  healthy: boolean
  response_ms: number | null
  error: string | null
}

export interface BackupLogEntry {
  id: string
  timestamp: string
  backup_type: string
  file_path: string | null
  size_bytes: number | null
  duration_seconds: number | null
  status: string
  error: string | null
  pruned_count: number
}

export interface CostSummaryModel {
  model: string
  cost_usd: number
  call_count: number
}

export interface CostSummary {
  month: string
  total_usd: number
  by_model: CostSummaryModel[]
}

export interface InfrastructureData {
  container_health: ContainerHealthEntry[]
  backups: BackupLogEntry[]
  cost: CostSummary
}

// ─── Pipeline flows ──────────────────────────────────────────────────────────

export interface PipelineFlowStage {
  stage: string
  status: string
  duration_ms: number | null
  error: string | null
  started_at: string | null
}

export interface PipelineFlowEntry {
  capture_id: string
  trace_id: string | null
  pipeline_status: string
  created_at: string
  stages: PipelineFlowStage[]
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

// ─── Email drafts ───────────────────────────────────────────────────────────

export type EmailDraftStatus = 'draft' | 'approved' | 'sent' | 'rejected' | 'failed'

export interface EmailDraft {
  id: string
  to_address: string
  cc_address: string | null
  subject: string
  body: string
  status: EmailDraftStatus
  send_mode: string
  source: string | null
  approved_at: string | null
  sent_at: string | null
  himalaya_message_id: string | null
  capture_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ─── Voice sessions ────────────────────────────────────────────────────────

export type TranscriptRole = 'user' | 'assistant'

export interface TranscriptTurn {
  role: TranscriptRole
  text: string
  timestamp: string
}

export interface VoiceSession {
  id: string
  session_key: string
  started_at: string
  ended_at: string | null
  duration_s: number | null
  turn_count: number
  captures_created: number
  summary: string | null
  transcript: TranscriptTurn[]
  capture_ids: string[]
}

// ─── Financial source_metadata (CS4a.4) ────────────────────────────────────
//
// Narrow type for `Capture.source_metadata` when the capture was produced by
// `scripts/financial-pipeline.py`. The Python pipeline writes one of seven
// metadata shapes, discriminated by `source_provider` (and, for Schwab, by
// the secondary `type` field, since Schwab has two snapshot variants that
// both carry `source_provider: 'schwab'`).

/** Financial provider identifiers emitted by the Python pipeline. */
export type FinancialSourceProvider =
  | 'amex' | 'chase' | 'truist' | 'schwab' | 'hsa' | 'paypal'

/** Per-category aggregate emitted by `_format_bank_capture`. */
export interface FinancialCategoryAggregate {
  count: number
  debit: number
  credit: number
}

/** Inclusive date range over the transactions in a bank-style capture. */
export interface FinancialDateRange {
  start: string | null
  end: string | null
}

/**
 * Common fields shared by all transactional (bank-style) financial captures:
 * amex, chase, truist, hsa, paypal. Produced by `_format_bank_capture`.
 */
interface BankLikeFinancialMetadataBase {
  /** Internal Python discriminator, e.g. `amex_activity`, `hsa_activity`. */
  type?: string
  account_id: string
  date_range: FinancialDateRange
  total_debit: number
  total_credit: number
  net: number
  transaction_count: number
  by_category: Record<string, FinancialCategoryAggregate>
  source_file?: string
}

/** Amex transaction-summary capture. */
export interface AmexSourceMetadata extends BankLikeFinancialMetadataBase {
  source_provider: 'amex'
}

/** Chase transaction-summary capture. */
export interface ChaseSourceMetadata extends BankLikeFinancialMetadataBase {
  source_provider: 'chase'
}

/** Truist transaction-summary capture. */
export interface TruistSourceMetadata extends BankLikeFinancialMetadataBase {
  source_provider: 'truist'
}

/** HSA transaction-summary capture. */
export interface HsaSourceMetadata extends BankLikeFinancialMetadataBase {
  source_provider: 'hsa'
}

/** PayPal transaction-summary capture. */
export interface PaypalSourceMetadata extends BankLikeFinancialMetadataBase {
  source_provider: 'paypal'
}

/**
 * Schwab balance snapshot (no transactions — account cash/market value as of a
 * point in time). Produced by `_format_schwab_balance_capture`. Discriminated
 * from positions via `type: 'schwab_balance_snapshot'`.
 */
export interface SchwabBalanceMetadata {
  source_provider: 'schwab'
  type: 'schwab_balance_snapshot'
  account_id: string
  account_mask: string
  as_of: string
  account_value: number
  cash: number
  market_value: number
  day_change: number
  day_change_pct: string
  non_margin?: number | null
  margin?: number | null
  sections?: Record<string, unknown>
  source_file?: string
}

/**
 * Schwab positions snapshot (holdings by market value). Produced by
 * `_format_schwab_position_capture`. Discriminated from balance via
 * `type: 'schwab_position_snapshot'`.
 */
export interface SchwabPositionsMetadata {
  source_provider: 'schwab'
  type: 'schwab_position_snapshot'
  account_id: string
  account_mask: string
  account_type?: string
  as_of: string
  total_value: number
  cost_basis?: number | null
  gain_dollar?: number | null
  gain_pct?: string
  positions: Array<{
    symbol?: string
    description?: string
    qty?: number | null
    price?: number | null
    mkt_val?: number | null
    // Per-position cost basis and gain metrics emitted by the Schwab CSV parser
    // (`_parse_schwab_position_csv` in scripts/financial-pipeline.py). Each
    // position row maps "Cost Basis", "Gain $ (Gain/Loss $)", "Gain %
    // (Gain/Loss %)" to these fields; `_num_or_none` returns null for '--' /
    // blank / 'N/A' sentinels (e.g. cash rows), so numeric fields are
    // nullable and `gain_pct` may be an empty string.
    cost_basis?: number | null
    gain_dollar?: number | null
    gain_pct?: string
    asset_type?: string
    [key: string]: unknown
  }>
  asset_types: Record<string, { count: number; mkt_val: number }>
  source_file?: string
}

/** Discriminated union of all financial capture metadata shapes. */
export type FinancialSourceMetadata =
  | AmexSourceMetadata
  | ChaseSourceMetadata
  | TruistSourceMetadata
  | SchwabBalanceMetadata
  | SchwabPositionsMetadata
  | HsaSourceMetadata
  | PaypalSourceMetadata

/** Set of valid `source_provider` values, used by the type guard. */
const FINANCIAL_PROVIDERS: ReadonlySet<FinancialSourceProvider> = new Set<FinancialSourceProvider>([
  'amex', 'chase', 'truist', 'schwab', 'hsa', 'paypal',
])

/**
 * Type predicate: narrows an opaque `source_metadata` record to
 * `FinancialSourceMetadata` when its `source_provider` is one of the known
 * financial provider keys.
 */
export function isFinancialSourceMetadata(
  meta: unknown
): meta is FinancialSourceMetadata {
  if (!meta || typeof meta !== 'object') return false
  const provider = (meta as { source_provider?: unknown }).source_provider
  return typeof provider === 'string' && FINANCIAL_PROVIDERS.has(provider as FinancialSourceProvider)
}

/** Narrower helper for Schwab balance snapshots. */
export function isSchwabBalanceMetadata(
  meta: FinancialSourceMetadata
): meta is SchwabBalanceMetadata {
  return meta.source_provider === 'schwab' && (meta as SchwabBalanceMetadata).type === 'schwab_balance_snapshot'
}

/** Narrower helper for Schwab positions snapshots. */
export function isSchwabPositionsMetadata(
  meta: FinancialSourceMetadata
): meta is SchwabPositionsMetadata {
  return meta.source_provider === 'schwab' && (meta as SchwabPositionsMetadata).type === 'schwab_position_snapshot'
}
