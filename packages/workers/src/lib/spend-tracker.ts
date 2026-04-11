import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface SpendCheckResult {
  /** Monthly non-Claude spend in USD */
  monthlySpend: number
  /** 'normal' | 'throttled' | 'paused' */
  action: 'normal' | 'throttled' | 'paused'
}

export interface SpendTrackerOptions {
  /** Soft limit — throttle embed queue when exceeded (default: $7) */
  softLimit: number
  /** Hard limit — pause embed queue when exceeded (default: $10) */
  hardLimit: number
  /** Cache duration in milliseconds (default: 60_000 = 1 minute) */
  cacheTtlMs: number
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_SOFT_LIMIT = 7 // USD
const DEFAULT_HARD_LIMIT = 10 // USD
const DEFAULT_CACHE_TTL_MS = 60_000 // 1 minute — avoid hitting DB on every job

// ============================================================
// SpendTracker
// ============================================================

/**
 * Spend-aware rate limiter for the embed-capture queue.
 *
 * Queries `ai_audit_log` for monthly non-Claude spend (WHERE client_used != 'anthropic')
 * and returns an action: 'normal', 'throttled', or 'paused'.
 *
 * - Under soft limit: normal processing
 * - Between soft and hard limit: throttled (caller adds delay)
 * - At or above hard limit: paused (caller skips job, re-queues with delay)
 *
 * Results are cached for `cacheTtlMs` to avoid per-job DB queries.
 * Claude SDK calls ($0 marginal cost via subscription) are excluded from spend totals.
 */
export class SpendTracker {
  private db: Database
  private opts: SpendTrackerOptions
  private cachedResult: SpendCheckResult | null = null
  private cacheExpiry = 0

  constructor(db: Database, opts?: Partial<SpendTrackerOptions>) {
    this.db = db
    this.opts = {
      softLimit: opts?.softLimit ?? Number(process.env.BUDGET_SOFT_LIMIT_NON_CLAUDE ?? DEFAULT_SOFT_LIMIT),
      hardLimit: opts?.hardLimit ?? Number(process.env.BUDGET_HARD_LIMIT_NON_CLAUDE ?? DEFAULT_HARD_LIMIT),
      cacheTtlMs: opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    }
  }

  /**
   * Check current monthly non-Claude spend and return the appropriate action.
   * Uses a short cache to avoid per-job DB queries.
   */
  async check(): Promise<SpendCheckResult> {
    const now = Date.now()

    // Return cached result if still valid
    if (this.cachedResult && now < this.cacheExpiry) {
      return this.cachedResult
    }

    const monthlySpend = await this.queryNonClaudeSpend()
    let action: SpendCheckResult['action'] = 'normal'

    if (monthlySpend >= this.opts.hardLimit) {
      action = 'paused'
      logger.warn(
        { monthlySpend, hardLimit: this.opts.hardLimit },
        '[spend-tracker] non-Claude spend at or above hard limit — embed queue paused',
      )
    } else if (monthlySpend >= this.opts.softLimit) {
      action = 'throttled'
      logger.info(
        { monthlySpend, softLimit: this.opts.softLimit },
        '[spend-tracker] non-Claude spend above soft limit — embed queue throttled',
      )
    }

    const result: SpendCheckResult = { monthlySpend, action }
    this.cachedResult = result
    this.cacheExpiry = now + this.opts.cacheTtlMs

    return result
  }

  /** Clear the cached result (for testing or forced refresh). */
  clearCache(): void {
    this.cachedResult = null
    this.cacheExpiry = 0
  }

  /**
   * Queries ai_audit_log for total non-Claude spend in the current calendar month.
   *
   * Uses the `cost_usd` column (populated by LLMGatewayService for each call).
   * Filters out Claude SDK calls (client_used = 'anthropic') since those are
   * covered by the subscription at $0 marginal cost.
   *
   * Falls back to token-based estimation if cost_usd is not populated.
   */
  private async queryNonClaudeSpend(): Promise<number> {
    try {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

      const result = await this.db.execute<{
        total_cost: string | null
        total_tokens: string | null
      }>(sql`
        SELECT
          SUM(COALESCE(cost_usd, 0)) AS total_cost,
          SUM(COALESCE(total_tokens, 0)) AS total_tokens
        FROM ai_audit_log
        WHERE created_at >= ${monthStart.toISOString()}::timestamptz
          AND error IS NULL
          AND (client_used IS NULL OR client_used != 'anthropic')
      `)

      const row = result.rows[0]
      if (!row) return 0

      const totalCost = row.total_cost ? Number(row.total_cost) : 0

      // If cost_usd is populated, use it directly
      if (totalCost > 0) {
        logger.debug({ totalCost }, '[spend-tracker] non-Claude spend from cost_usd')
        return totalCost
      }

      // Fallback: estimate from token counts ($1/1M tokens — conservative)
      const totalTokens = row.total_tokens ? Number(row.total_tokens) : 0
      const estimated = (totalTokens / 1_000_000) * 1.0

      logger.debug({ totalTokens, estimated }, '[spend-tracker] non-Claude spend from token estimate')
      return estimated
    } catch (err) {
      logger.warn({ err }, '[spend-tracker] failed to query ai_audit_log — assuming $0 spend')
      return 0
    }
  }
}
