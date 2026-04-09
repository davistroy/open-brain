import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  processAccessStatsJob,
  generateCanonicalPairs,
  upsertCoAccessAssociations,
} from '../jobs/update-access-stats.js'

// ============================================================
// Mock logger to suppress test output
// ============================================================
vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-brain/shared')>()
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

// ============================================================
// Fixtures
// ============================================================
const TIMESTAMP = '2026-04-09T12:00:00Z'

// UUIDs sorted lexicographically: A < B < C < D
const UUID_A = '00000000-0000-0000-0000-000000000001'
const UUID_B = '00000000-0000-0000-0000-000000000002'
const UUID_C = '00000000-0000-0000-0000-000000000003'
const UUID_D = '00000000-0000-0000-0000-000000000004'

// ============================================================
// Mock DB helpers
// ============================================================

function makeMockDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined)
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate })
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where })

  return {
    update: vi.fn().mockReturnValue({ set }),
    insert: vi.fn().mockReturnValue({ values }),
    _set: set,
    _where: where,
    _values: values,
    _onConflictDoUpdate: onConflictDoUpdate,
  }
}

// ============================================================
// generateCanonicalPairs — pure function tests
// ============================================================

describe('generateCanonicalPairs', () => {
  it('returns empty array for empty input', () => {
    expect(generateCanonicalPairs([])).toEqual([])
  })

  it('returns empty array for single ID', () => {
    expect(generateCanonicalPairs([UUID_A])).toEqual([])
  })

  it('returns one pair for two IDs in correct order', () => {
    const pairs = generateCanonicalPairs([UUID_A, UUID_B])
    expect(pairs).toEqual([[UUID_A, UUID_B]])
  })

  it('maintains canonical ordering when input is reversed', () => {
    // UUID_B > UUID_A, so output should still be [A, B]
    const pairs = generateCanonicalPairs([UUID_B, UUID_A])
    expect(pairs).toEqual([[UUID_A, UUID_B]])
  })

  it('generates all 3 pairs from 3 IDs', () => {
    const pairs = generateCanonicalPairs([UUID_A, UUID_B, UUID_C])
    expect(pairs).toHaveLength(3)
    expect(pairs).toContainEqual([UUID_A, UUID_B])
    expect(pairs).toContainEqual([UUID_A, UUID_C])
    expect(pairs).toContainEqual([UUID_B, UUID_C])
  })

  it('generates all 6 pairs from 4 IDs (C(4,2) = 6)', () => {
    const pairs = generateCanonicalPairs([UUID_A, UUID_B, UUID_C, UUID_D])
    expect(pairs).toHaveLength(6)
  })

  it('always puts smaller UUID first regardless of input order', () => {
    // Reverse order input
    const pairs = generateCanonicalPairs([UUID_D, UUID_C, UUID_B, UUID_A])
    for (const [a, b] of pairs) {
      expect(a < b).toBe(true)
    }
  })

  it('generates C(n,2) pairs for n items', () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      `00000000-0000-0000-0000-00000000${String(i).padStart(4, '0')}`
    )
    const pairs = generateCanonicalPairs(ids)
    // C(10, 2) = 45
    expect(pairs).toHaveLength(45)
  })
})

// ============================================================
// upsertCoAccessAssociations
// ============================================================

describe('upsertCoAccessAssociations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 0 for empty pairs', async () => {
    const db = makeMockDb()
    const result = await upsertCoAccessAssociations([], TIMESTAMP, db as any)
    expect(result).toBe(0)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('calls insert for each pair', async () => {
    const db = makeMockDb()
    const pairs: Array<[string, string]> = [
      [UUID_A, UUID_B],
      [UUID_A, UUID_C],
    ]

    const result = await upsertCoAccessAssociations(pairs, TIMESTAMP, db as any)

    expect(result).toBe(2)
    expect(db.insert).toHaveBeenCalledTimes(2)
  })

  it('provides onConflictDoUpdate for upsert behavior', async () => {
    const db = makeMockDb()
    const pairs: Array<[string, string]> = [[UUID_A, UUID_B]]

    await upsertCoAccessAssociations(pairs, TIMESTAMP, db as any)

    expect(db._onConflictDoUpdate).toHaveBeenCalledTimes(1)
    const conflictArg = db._onConflictDoUpdate.mock.calls[0][0]
    // Should target the unique pair columns
    expect(conflictArg.target).toBeDefined()
    expect(conflictArg.set).toBeDefined()
    // The set should update co_access_count, last_co_access, and weight
    expect(conflictArg.set.co_access_count).toBeDefined()
    expect(conflictArg.set.last_co_access).toBeDefined()
    expect(conflictArg.set.weight).toBeDefined()
  })

  it('inserts with initial weight of 1.0 and co_access_count of 1', async () => {
    const db = makeMockDb()
    const pairs: Array<[string, string]> = [[UUID_A, UUID_B]]

    await upsertCoAccessAssociations(pairs, TIMESTAMP, db as any)

    const insertedValues = db._values.mock.calls[0][0]
    expect(insertedValues.capture_id_a).toBe(UUID_A)
    expect(insertedValues.capture_id_b).toBe(UUID_B)
    expect(insertedValues.co_access_count).toBe(1)
    expect(insertedValues.weight).toBe(1.0)
  })
})

// ============================================================
// processAccessStatsJob — integration
// ============================================================

describe('processAccessStatsJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing for empty captureIds', async () => {
    const db = makeMockDb()
    await processAccessStatsJob({ captureIds: [], accessedAt: TIMESTAMP }, db as any)
    expect(db.update).not.toHaveBeenCalled()
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('updates access stats for single capture (no co-access)', async () => {
    const db = makeMockDb()
    await processAccessStatsJob(
      { captureIds: [UUID_A], accessedAt: TIMESTAMP },
      db as any,
    )

    // Should update access_count
    expect(db.update).toHaveBeenCalledTimes(1)
    // Should NOT insert associations (need >= 2 captures)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('updates access stats AND creates co-access associations for 2+ captures', async () => {
    const db = makeMockDb()
    await processAccessStatsJob(
      { captureIds: [UUID_A, UUID_B, UUID_C], accessedAt: TIMESTAMP },
      db as any,
    )

    // Access stats update
    expect(db.update).toHaveBeenCalledTimes(1)
    // 3 pairs: A-B, A-C, B-C
    expect(db.insert).toHaveBeenCalledTimes(3)
  })

  it('limits co-access pairing to top 10 results', async () => {
    const db = makeMockDb()
    // Create 15 UUIDs
    const ids = Array.from({ length: 15 }, (_, i) =>
      `00000000-0000-0000-0000-00000000${String(i).padStart(4, '0')}`
    )

    await processAccessStatsJob(
      { captureIds: ids, accessedAt: TIMESTAMP },
      db as any,
    )

    // All 15 get access_count update
    expect(db.update).toHaveBeenCalledTimes(1)
    // Only top 10 are paired: C(10, 2) = 45
    expect(db.insert).toHaveBeenCalledTimes(45)
  })

  it('does not fail when co-access upsert throws', async () => {
    const db = makeMockDb()
    // Make insert throw on first call
    db._onConflictDoUpdate.mockRejectedValueOnce(new Error('DB constraint violation'))

    // Should not throw — co-access is best-effort
    await expect(
      processAccessStatsJob(
        { captureIds: [UUID_A, UUID_B], accessedAt: TIMESTAMP },
        db as any,
      ),
    ).resolves.not.toThrow()

    // Access stats update should still have been called
    expect(db.update).toHaveBeenCalledTimes(1)
  })
})
