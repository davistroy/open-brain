import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database, PushoverService, LLMGatewayService, TemplateCache, ConfigService } from '@open-brain/shared'

// ============================================================
// Shared result interface — all skills return at least durationMs
// ============================================================

export interface BaseResult {
  durationMs: number
  notificationSent?: boolean
  status?: 'gated'  // set by BaseSkill.execute() when autonomy gate blocks execution
}

// ============================================================
// Constructor option interfaces
// ============================================================

/**
 * Options for simple skills that only need DB and optional Pushover.
 * Used by: capture-reminder, container-health, secret-rotation,
 * stale-captures, storage-audit.
 */
export interface BaseSkillOpts {
  db: Database
  pushover?: PushoverService
}

/**
 * Options for LLM-heavy synthesis skills that need the full LLM stack.
 * Used by: daily-connections, drift-monitor, daily-sweep-skill,
 * weekly-brief, memory-consolidation, email-compose, cost-analysis.
 */
export interface LLMSkillOpts extends BaseSkillOpts {
  litellmBaseUrl?: string
  litellmApiKey?: string
  litellmClient?: OpenAI
  anthropicClient?: Anthropic
  llmGateway?: LLMGatewayService
  templates?: TemplateCache
  promptsDir?: string
  coreApiUrl?: string
  /**
   * Loaded ConfigService instance. Required by skills that resolve
   * task-indexed model aliases via `resolveTaskModel()` at init time
   * (e.g., EmailComposeSkill routes `email_compose` via ai-routing.yaml).
   */
  configService?: ConfigService
}
