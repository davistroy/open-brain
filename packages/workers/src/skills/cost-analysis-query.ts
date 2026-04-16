import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { BaseResult } from './types.js'

// ============================================================
// Types
// ============================================================

export interface CostAnalysisOptions {
  /** Override "now" for deterministic testing. */
  now?: Date
  /** Daily spend alert threshold in USD. Default: 2.00. */
  dailyAlertThreshold?: number
  /** Wiki output directory (relative to wiki root). Default: operations/cost-reports */
  wikiDir?: string
  /** LiteLLM spend URL (overrides LITELLM_SPEND_URL env var). Empty string = skip. */
  litellmSpendUrl?: string
  /** LiteLLM API key (overrides LITELLM_API_KEY env var). */
  litellmApiKey?: string
}

export interface ModelCost {
  model: string
  task_type: string
  call_count: number
  total_tokens: number
  cost_usd: number
}

export interface DailyCostSummary {
  date: string
  totalCost: number
  totalTokens: number
  totalCalls: number
  byModel: ModelCost[]
}

export interface CostAnalysisResult extends BaseResult {
  type: 'daily' | 'weekly' | 'monthly'
  summary: DailyCostSummary
  /** Weekly summary (last 7 days), only present on Mondays */
  weeklySummary?: DailyCostSummary
  /** Monthly summary (previous month), only present on 1st of month */
  monthlySummary?: DailyCostSummary
  alertSent: boolean
  wikiPageWritten: boolean
}

// ============================================================
// Query: ai_audit_log spend (local estimation)
// ============================================================

/**
 * Query spend from ai_audit_log for a date range.
 * Returns aggregated cost data grouped by model and task_type.
 */
export async function querySpend(db: Database, from: Date, to: Date): Promise<DailyCostSummary> {
  try {
    const rows = await db.execute<{
      model: string
      task_type: string
      call_count: string
      total_tokens: string
      cost_usd: string
    }>(sql`
      SELECT
        model,
        task_type,
        COUNT(*)::text AS call_count,
        COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
        COALESCE(SUM(cost_usd::numeric), 0)::text AS cost_usd
      FROM ai_audit_log
      WHERE created_at >= ${from.toISOString()}::timestamptz
        AND created_at < ${to.toISOString()}::timestamptz
      GROUP BY model, task_type
      ORDER BY cost_usd DESC
    `)

    const byModel: ModelCost[] = rows.rows.map(r => ({
      model: r.model,
      task_type: r.task_type,
      call_count: Number(r.call_count),
      total_tokens: Number(r.total_tokens),
      cost_usd: Number(Number(r.cost_usd).toFixed(6)),
    }))

    const totalCost = byModel.reduce((sum, m) => sum + m.cost_usd, 0)
    const totalTokens = byModel.reduce((sum, m) => sum + m.total_tokens, 0)
    const totalCalls = byModel.reduce((sum, m) => sum + m.call_count, 0)

    return {
      date: '',
      totalCost: Number(totalCost.toFixed(6)),
      totalTokens,
      totalCalls,
      byModel,
    }
  } catch (err) {
    logger.warn({ err }, '[cost-analysis] failed to query ai_audit_log')
    return { date: '', totalCost: 0, totalTokens: 0, totalCalls: 0, byModel: [] }
  }
}
