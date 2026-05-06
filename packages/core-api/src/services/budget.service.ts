/**
 * BudgetService — owns AI spend query logic extracted from routes/config.ts.
 *
 * Phase 5.2 of IMPLEMENTATION_PLAN-ARCH-REVIEW.md.
 *
 * Provides:
 *   getSpend(month) — per-model monthly spend from ai_audit_log for a given
 *   YYYY-MM month string. Returns the same shape the config route used
 *   to assemble inline — a flat Record<model, {spend, calls}> plus a monthTotal.
 *   Route handler maps these into ModelRoutingEntry fields; the wire contract
 *   (AIRoutingResponse) is unchanged.
 *
 * Error contract:
 *   - DB failure logs a warning and returns empty spend (zero graceful degradation).
 *   - No c.json() calls — this service is HTTP-agnostic.
 */

import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Types (exported so route and tests can reference without re-declaring)
// ---------------------------------------------------------------------------

export interface ModelSpendEntry {
  spend: number
  calls: number
}

export interface SpendResult {
  /** Keyed by model name. Models with no rows are absent (treat as 0). */
  byModel: Record<string, ModelSpendEntry>
  /** Sum of all model spend for the month (USD). */
  monthTotal: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BudgetService {
  constructor(private readonly db: Database) {}

  /**
   * Query per-model spend from `ai_audit_log` for the given calendar month.
   *
   * @param month  YYYY-MM string (e.g. "2026-05"). Must match the format
   *               `date_trunc('month', CURRENT_DATE)` returns for the current
   *               month. Passing the wrong format will return empty rows (no
   *               throw — callers treat missing month as zero spend).
   */
  async getSpend(month: string): Promise<SpendResult> {
    const byModel: Record<string, ModelSpendEntry> = {}
    let monthTotal = 0

    try {
      // Parse the YYYY-MM string so we can build a Postgres date literal.
      // date_trunc('month', CURRENT_DATE) returns the first of the current
      // month as a date — we replicate that by appending "-01".
      const monthStart = `${month}-01`

      const rows = await this.db.execute<{
        model: string
        total_spend: string | null
        call_count: string | null
      }>(sql`
        SELECT
          model,
          COALESCE(SUM(cost_usd), 0) AS total_spend,
          COUNT(*)::text AS call_count
        FROM ai_audit_log
        WHERE created_at >= ${monthStart}::date
          AND created_at <  (${monthStart}::date + INTERVAL '1 month')
        GROUP BY model
      `)

      for (const row of rows.rows) {
        const spend = parseFloat(String(row.total_spend))
        const calls = parseInt(String(row.call_count), 10)
        byModel[row.model] = { spend, calls }
        monthTotal += spend
      }
    } catch (err) {
      logger.warn({ err, month }, 'BudgetService: failed to query per-model spend; returning zero')
    }

    return { byModel, monthTotal }
  }
}
