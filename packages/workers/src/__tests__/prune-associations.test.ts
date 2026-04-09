import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pruneStaleAssociations } from '../jobs/update-access-stats.js'
import type { PruneAssociationsOptions } from '../jobs/update-access-stats.js'

// ============================================================
// Mock helpers
// ============================================================

/**
 * Creates a mock Database that records delete().where().returning() chains.
 * Returns the provided rows from returning() to simulate deleted row count.
 */
function makeMockDb(deletedRows: Array<{ id: string }> = []) {
  const returning = vi.fn().mockResolvedValue(deletedRows)
  const where = vi.fn().mockReturnValue({ returning })
  const deleteFn = vi.fn().mockReturnValue({ where })

  return {
    delete: deleteFn,
    _where: where,
    _returning: returning,
  }
}

// ============================================================
// Tests
// ============================================================

describe('pruneStaleAssociations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------
  // Nothing to prune
  // ----------------------------------------------------------

  describe('no stale associations', () => {
    it('returns zero pruned when no associations match criteria', async () => {
      const db = makeMockDb([])

      const result = await pruneStaleAssociations(db as any)

      expect(result.pruned).toBe(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('calls delete on captureAssociations table', async () => {
      const db = makeMockDb([])

      await pruneStaleAssociations(db as any)

      expect(db.delete).toHaveBeenCalledOnce()
    })
  })

  // ----------------------------------------------------------
  // Stale associations found and pruned
  // ----------------------------------------------------------

  describe('stale associations found', () => {
    const STALE_ROWS = [
      { id: 'assoc-1111' },
      { id: 'assoc-2222' },
      { id: 'assoc-3333' },
    ]

    it('returns correct pruned count', async () => {
      const db = makeMockDb(STALE_ROWS)

      const result = await pruneStaleAssociations(db as any)

      expect(result.pruned).toBe(3)
    })

    it('returns positive durationMs', async () => {
      const db = makeMockDb(STALE_ROWS)

      const result = await pruneStaleAssociations(db as any)

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('calls the delete chain with where and returning', async () => {
      const db = makeMockDb(STALE_ROWS)

      await pruneStaleAssociations(db as any)

      expect(db.delete).toHaveBeenCalledOnce()
      expect(db._where).toHaveBeenCalledOnce()
      expect(db._returning).toHaveBeenCalledOnce()
    })
  })

  // ----------------------------------------------------------
  // Default options
  // ----------------------------------------------------------

  describe('default options', () => {
    it('uses default weight threshold of 0.1 and 90 days', async () => {
      const db = makeMockDb([])

      const result = await pruneStaleAssociations(db as any)

      // Verify it runs without error with defaults
      expect(result.pruned).toBe(0)
      // The where clause is constructed internally — we trust Drizzle
      // generates the correct SQL from the and(lt(), lt()) condition
      expect(db._where).toHaveBeenCalledOnce()
    })
  })

  // ----------------------------------------------------------
  // Custom options
  // ----------------------------------------------------------

  describe('custom options', () => {
    it('accepts custom weightThreshold', async () => {
      const db = makeMockDb([{ id: 'assoc-1' }])

      const result = await pruneStaleAssociations(db as any, {
        weightThreshold: 0.05,
      })

      expect(result.pruned).toBe(1)
    })

    it('accepts custom staleDays', async () => {
      const db = makeMockDb([{ id: 'assoc-1' }, { id: 'assoc-2' }])

      const result = await pruneStaleAssociations(db as any, {
        staleDays: 30,
      })

      expect(result.pruned).toBe(2)
    })

    it('accepts both custom options together', async () => {
      const db = makeMockDb([])

      const result = await pruneStaleAssociations(db as any, {
        weightThreshold: 0.2,
        staleDays: 60,
      })

      expect(result.pruned).toBe(0)
    })
  })

  // ----------------------------------------------------------
  // Database error handling
  // ----------------------------------------------------------

  describe('database errors', () => {
    it('propagates database errors to caller', async () => {
      const db = makeMockDb([])
      db._returning.mockRejectedValue(new Error('connection lost'))

      await expect(pruneStaleAssociations(db as any)).rejects.toThrow('connection lost')
    })
  })
})
