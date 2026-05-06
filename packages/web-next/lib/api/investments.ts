/**
 * investmentsApi — Schwab balance + positions data (M3, screen 5.4)
 *
 * There are no dedicated /investments API endpoints. Investment data lives
 * as financial pipeline captures with source_provider='schwab'. This namespace
 * fetches schwab captures and shapes them into normalized records for the
 * HoldingsTable and AllocationChart client components.
 *
 * All heavy transformation (latestBalances, latestPositions, balanceHistory)
 * is client-side (same as /web InvestmentsApi). The server RSC page fetches
 * the raw captures via capturesApi.list; client components receive the raw
 * capture list and do the shaping themselves so the RSC stays simple.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request, buildQueryString } from './core'
import type { ListEnvelope, Capture } from './core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One balance snapshot, normalized from schwab_balance_snapshot metadata. */
export interface SchwabSnapshotRecord {
  capture_id: string
  created_at: string
  account_name: string
  account_mask: string
  as_of: string
  account_value: number
  cash_value: number
  market_value: number
  day_change: number
  day_change_pct: string
}

/** One holding row extracted from schwab_position_snapshot metadata. */
export interface SchwabHolding {
  symbol: string
  description: string
  qty: number
  price: number
  market_value: number
  cost_basis: number
  gain_dollar: number
  gain_pct: string
  asset_type: string
}

/** Positions snapshot normalized per account, with flattened holdings. */
export interface SchwabPositionsRecord {
  capture_id: string
  created_at: string
  account_name: string
  account_mask: string
  as_of: string
  total_value: number
  cost_basis: number
  gain_dollar: number
  gain_pct: string
  holdings: SchwabHolding[]
}

// ---------------------------------------------------------------------------
// API namespace
// ---------------------------------------------------------------------------

/**
 * Fetch the raw Schwab captures that the RSC page passes to client components.
 * This is the only actual API call — all shaping is done client-side.
 */
export const investmentsApi = {
  /** GET /api/v1/captures?source_provider=schwab&limit=200 */
  rawCaptures: (limit = 200): Promise<ListEnvelope<Capture>> =>
    request<ListEnvelope<Capture>>(
      `/captures${buildQueryString({ source_provider: 'schwab', limit })}`,
    ),
}
