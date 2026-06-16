import type { Database } from '../db/index.js'
import { ai_audit_log } from '../schema/index.js'
import { logger } from '../lib/logger.js'
import type { AIClientType } from '../types/config.js'

/**
 * A single AI-spend event to persist in `ai_audit_log`.
 *
 * Mirrors the columns the LLM gateway records for completion calls, so the
 * budget circuit breaker (SpendTracker, which SUMs `ai_audit_log` where
 * `client_used != 'anthropic'`) sees a complete picture.
 */
export interface SpendRecord {
  taskType: string
  model: string
  clientUsed: AIClientType
  costUsd: number | null
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  durationMs?: number
  captureId?: string
  sessionId?: string
  error?: string
}

/**
 * Records one AI-spend event in `ai_audit_log`.
 *
 * This is the single writer for the budget audit trail — `LLMGatewayService`
 * uses it for completions, and (INT-M2) `EmbeddingService` + the voice
 * `ClassificationService` use it for the OpenAI calls they make directly,
 * which previously bypassed the gateway and left the budget breaker blind
 * (the 2026-04 bulk-ingest cost incident).
 *
 * Audit failures must NEVER break the caller — they are logged and swallowed.
 */
export async function recordSpend(db: Database, params: SpendRecord): Promise<void> {
  try {
    await db.insert(ai_audit_log).values({
      task_type: params.taskType,
      model: params.model,
      prompt_tokens: params.promptTokens ?? null,
      completion_tokens: params.completionTokens ?? null,
      total_tokens: params.totalTokens ?? null,
      duration_ms: params.durationMs ?? null,
      capture_id: params.captureId ?? null,
      session_id: params.sessionId ?? null,
      error: params.error ?? null,
      client_used: params.clientUsed,
      cost_usd: params.costUsd !== null ? String(params.costUsd) : null,
    })
  } catch (err) {
    logger.error({ err, taskType: params.taskType }, 'Failed to write spend audit log')
  }
}
