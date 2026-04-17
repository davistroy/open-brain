import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database, PushoverService, LLMGatewayService, TemplateCache } from '@open-brain/shared'

// ============================================================
// Shared result interface — all skills return at least durationMs
// ============================================================

export interface BaseResult {
  durationMs: number
  notificationSent?: boolean
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
}
