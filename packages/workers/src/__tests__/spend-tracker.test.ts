import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SpendTracker } from '../lib/spend-tracker.js'

// ============================================================
// Mock database
// ============================================================

function makeDb(totalCost: number | null, totalTokens: number | null = null) {
  return {
    execute: vi.fn().mockResolvedValue({
      rows: [{
        total_cost: totalCost !== null ? String(totalCost) : null,
        total_tokens: totalTokens !== null ? String(totalTokens) : null,
      }],
    }),
  }
}

function makeDbEmpty() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

function makeDbError() {
  return {
    execute: vi.fn().mockRejectedValue(new Error('DB connection error')),
  }
}

// ============================================================
// Tests
// ============================================================

describe('SpendTracker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.BUDGET_SOFT_LIMIT_NON_CLAUDE
    delete process.env.BUDGET_HARD_LIMIT_NON_CLAUDE
  })

  // ----------------------------------------------------------
  // Normal operation — under soft limit
  // ----------------------------------------------------------

  describe('spend under soft limit', () => {
    it('returns action=normal when spend is under soft limit', async () => {
      const db = makeDb(3.50)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('normal')
      expect(result.monthlySpend).toBe(3.50)
    })

    it('returns action=normal when spend is $0', async () => {
      const db = makeDb(0)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('normal')
      expect(result.monthlySpend).toBe(0)
    })

    it('returns action=normal when no rows returned', async () => {
      const db = makeDbEmpty()
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('normal')
      expect(result.monthlySpend).toBe(0)
    })
  })

  // ----------------------------------------------------------
  // Throttled — between soft and hard limit
  // ----------------------------------------------------------

  describe('spend between soft and hard limit', () => {
    it('returns action=throttled when spend equals soft limit', async () => {
      const db = makeDb(7.00)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('throttled')
      expect(result.monthlySpend).toBe(7.00)
    })

    it('returns action=throttled when spend is between soft and hard limit', async () => {
      const db = makeDb(8.50)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('throttled')
      expect(result.monthlySpend).toBe(8.50)
    })
  })

  // ----------------------------------------------------------
  // Paused — at or above hard limit
  // ----------------------------------------------------------

  describe('spend at or above hard limit', () => {
    it('returns action=paused when spend equals hard limit', async () => {
      const db = makeDb(10.00)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('paused')
      expect(result.monthlySpend).toBe(10.00)
    })

    it('returns action=paused when spend exceeds hard limit', async () => {
      const db = makeDb(15.00)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('paused')
      expect(result.monthlySpend).toBe(15.00)
    })
  })

  // ----------------------------------------------------------
  // Token-based fallback
  // ----------------------------------------------------------

  describe('token-based fallback when cost_usd is 0', () => {
    it('estimates spend from token counts at $1/1M tokens', async () => {
      // cost_usd=0, 8M tokens → estimated $8 → throttled ($7 soft limit)
      const db = makeDb(0, 8_000_000)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('throttled')
      expect(result.monthlySpend).toBeCloseTo(8.00, 2)
    })

    it('estimates $0 when both cost and tokens are 0', async () => {
      const db = makeDb(0, 0)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('normal')
      expect(result.monthlySpend).toBe(0)
    })
  })

  // ----------------------------------------------------------
  // DB error handling
  // ----------------------------------------------------------

  describe('database error handling', () => {
    it('returns action=normal and $0 spend when DB query fails', async () => {
      const db = makeDbError()
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      const result = await tracker.check()

      expect(result.action).toBe('normal')
      expect(result.monthlySpend).toBe(0)
    })
  })

  // ----------------------------------------------------------
  // Caching
  // ----------------------------------------------------------

  describe('result caching', () => {
    it('returns cached result within TTL without re-querying DB', async () => {
      const db = makeDb(5.00)
      // Large cache TTL to ensure second call is cached
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 60_000 })

      const result1 = await tracker.check()
      const result2 = await tracker.check()

      expect(result1.action).toBe('normal')
      expect(result2.action).toBe('normal')
      // DB should only be queried once
      expect(db.execute).toHaveBeenCalledOnce()
    })

    it('re-queries DB after cache expires', async () => {
      const db = makeDb(5.00)
      // Zero cache TTL — always re-query
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 0 })

      await tracker.check()
      await tracker.check()

      // DB queried twice (no caching)
      expect(db.execute).toHaveBeenCalledTimes(2)
    })

    it('clearCache forces re-query on next check', async () => {
      const db = makeDb(5.00)
      const tracker = new SpendTracker(db as never, { softLimit: 7, hardLimit: 10, cacheTtlMs: 60_000 })

      await tracker.check()
      expect(db.execute).toHaveBeenCalledOnce()

      tracker.clearCache()
      await tracker.check()
      expect(db.execute).toHaveBeenCalledTimes(2)
    })
  })

  // ----------------------------------------------------------
  // Environment variable configuration
  // ----------------------------------------------------------

  describe('environment variable configuration', () => {
    it('reads BUDGET_SOFT_LIMIT_NON_CLAUDE from environment', async () => {
      process.env.BUDGET_SOFT_LIMIT_NON_CLAUDE = '5'

      const db = makeDb(6.00)
      const tracker = new SpendTracker(db as never, { cacheTtlMs: 0 })

      const result = await tracker.check()

      // $6 > $5 soft limit → throttled
      expect(result.action).toBe('throttled')
    })

    it('reads BUDGET_HARD_LIMIT_NON_CLAUDE from environment', async () => {
      process.env.BUDGET_HARD_LIMIT_NON_CLAUDE = '8'

      const db = makeDb(9.00)
      const tracker = new SpendTracker(db as never, { cacheTtlMs: 0 })

      const result = await tracker.check()

      // $9 > $8 hard limit → paused
      expect(result.action).toBe('paused')
    })

    it('defaults to $7 soft and $10 hard when env vars not set', async () => {
      const db = makeDb(6.99)
      const tracker = new SpendTracker(db as never, { cacheTtlMs: 0 })

      const result = await tracker.check()

      // $6.99 < $7 default soft limit → normal
      expect(result.action).toBe('normal')
    })
  })
})
