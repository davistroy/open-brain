import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  buildClusters,
  querySimilarPairs,
  findConsolidationCandidates,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_MIN_CLUSTER_SIZE,
  DEFAULT_MAX_CLUSTERS,
} from '../skills/memory-consolidation-query.js'
import type { SimilarityPairRow } from '../skills/memory-consolidation-query.js'
import { findSimilarPairs } from '../lib/hnsw-similarity.js'
import type { SimilarPair } from '../lib/hnsw-similarity.js'

// This test exercises the REAL memory-consolidation-query.ts implementation
// (memory-consolidation.test.ts mocks this module wholesale to unit-isolate the
// skill's orchestration — this file is the missing coverage for the module itself).
// Only the k-NN dependency is mocked.
vi.mock('../lib/hnsw-similarity.js', () => ({
  findSimilarPairs: vi.fn(),
}))

function renderSql(arg: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(arg as any)
}

function pair(a: string, b: string, similarity: number): SimilarityPairRow {
  return { capture_id_a: a, capture_id_b: b, similarity: String(similarity) }
}

// ============================================================
// buildClusters() — pure union-find, no mocks
// ============================================================

describe('buildClusters()', () => {
  it('returns [] for empty pairs', () => {
    expect(buildClusters([], 3, 5)).toEqual([])
  })

  it('drops a single pair below minClusterSize', () => {
    // A single pair forms a cluster of size 2; default minClusterSize is 3.
    const pairs = [pair('a', 'b', 0.95)]
    expect(buildClusters(pairs, 3, 5)).toEqual([])
  })

  it('keeps a single pair at exactly minClusterSize', () => {
    const pairs = [pair('a', 'b', 0.95)]
    const clusters = buildClusters(pairs, 2, 5)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].captureIds).toEqual(['a', 'b'])
    expect(clusters[0].avgSimilarity).toBeCloseTo(0.95)
    expect(clusters[0].minSimilarity).toBeCloseTo(0.95)
  })

  it('transitively clusters a-b, b-c into one {a,b,c} cluster with correct stats', () => {
    // a-b and b-c are known pairs; a-c is NOT a known pair (no direct edge),
    // so cluster stats are computed only from the known pairwise similarities.
    const pairs = [pair('a', 'b', 0.94), pair('b', 'c', 0.96)]
    const clusters = buildClusters(pairs, 3, 5)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].captureIds).toEqual(['a', 'b', 'c'])
    expect(clusters[0].avgSimilarity).toBeCloseTo((0.94 + 0.96) / 2)
    expect(clusters[0].minSimilarity).toBeCloseTo(0.94)
  })

  it('computes avg/min correctly across all three edges of a fully-connected triangle', () => {
    const pairs = [pair('a', 'b', 0.93), pair('b', 'c', 0.97), pair('a', 'c', 0.95)]
    const clusters = buildClusters(pairs, 3, 5)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].captureIds).toEqual(['a', 'b', 'c'])
    expect(clusters[0].avgSimilarity).toBeCloseTo((0.93 + 0.97 + 0.95) / 3)
    expect(clusters[0].minSimilarity).toBeCloseTo(0.93)
  })

  it('keeps disjoint clusters separate with independently computed stats', () => {
    const pairs = [
      pair('a', 'b', 0.93), pair('b', 'c', 0.95), // cluster 1: {a,b,c}
      pair('x', 'y', 0.99), pair('y', 'z', 0.98), // cluster 2: {x,y,z}
    ]
    const clusters = buildClusters(pairs, 3, 5)
    expect(clusters).toHaveLength(2)
    const ids = clusters.map((c) => c.captureIds.sort().join(','))
    expect(ids).toContain('a,b,c')
    expect(ids).toContain('x,y,z')
  })

  it('sorts by cluster size desc, then avgSimilarity desc, and truncates to maxClusters', () => {
    const pairs = [
      // cluster A: size 2, avg 0.93
      pair('a1', 'a2', 0.93),
      // cluster B: size 3, avg (0.94+0.96)/2 = 0.95
      pair('b1', 'b2', 0.94), pair('b2', 'b3', 0.96),
      // cluster C: size 3, avg (0.99+0.99)/2 = 0.99 (higher avg than B, same size)
      pair('c1', 'c2', 0.99), pair('c2', 'c3', 0.99),
      // cluster D: size 2, avg 0.92
      pair('d1', 'd2', 0.92),
    ]
    const clusters = buildClusters(pairs, 2, 3)
    expect(clusters).toHaveLength(3) // truncated from 4 to maxClusters=3
    // Both size-3 clusters (C, B) rank ahead of any size-2 cluster; C (higher avg) before B.
    expect(clusters[0].captureIds).toEqual(['c1', 'c2', 'c3'])
    expect(clusters[1].captureIds).toEqual(['b1', 'b2', 'b3'])
    // Third slot is whichever size-2 cluster has the higher avgSimilarity (A: 0.93 > D: 0.92).
    expect(clusters[2].captureIds).toEqual(['a1', 'a2'])
  })

  it('applies default minClusterSize/maxClusters when not passed', () => {
    // DEFAULT_MIN_CLUSTER_SIZE = 3: a 2-member cluster is dropped by default.
    const pairs = [pair('a', 'b', 0.95)]
    expect(buildClusters(pairs)).toEqual([])
    expect(DEFAULT_MIN_CLUSTER_SIZE).toBe(3)
    expect(DEFAULT_MAX_CLUSTERS).toBe(5)
  })
})

// ============================================================
// querySimilarPairs() — k-NN path (default; findSimilarPairs mocked)
// ============================================================

describe('querySimilarPairs() — k-NN path', () => {
  beforeEach(() => {
    vi.mocked(findSimilarPairs).mockReset()
  })

  it('delegates to findSimilarPairs with the given threshold and maps rows to string similarity', async () => {
    const dbPairs: SimilarPair[] = [
      { capture_id_a: 'a', capture_id_b: 'b', similarity: 0.9345 },
    ]
    vi.mocked(findSimilarPairs).mockResolvedValue(dbPairs)

    const db = {} as any
    const rows = await querySimilarPairs(db, 0.9, null)

    expect(findSimilarPairs).toHaveBeenCalledTimes(1)
    expect(findSimilarPairs).toHaveBeenCalledWith(db, {
      threshold: 0.9,
      maxPairs: 5000,
      excludeConsolidationSource: false,
      candidatesSince: null,
    })
    expect(rows).toEqual([{ capture_id_a: 'a', capture_id_b: 'b', similarity: '0.9345' }])
  })

  it('passes candidatesSince through for incremental scoping', async () => {
    vi.mocked(findSimilarPairs).mockResolvedValue([])
    const since = new Date('2026-06-01T00:00:00.000Z')
    const db = {} as any
    await querySimilarPairs(db, 0.92, since)

    expect(findSimilarPairs).toHaveBeenCalledWith(db, {
      threshold: 0.92,
      maxPairs: 5000,
      excludeConsolidationSource: false,
      candidatesSince: since,
    })
  })

  it('applies default threshold and candidatesSince when omitted', async () => {
    vi.mocked(findSimilarPairs).mockResolvedValue([])
    const db = {} as any
    await querySimilarPairs(db)

    expect(findSimilarPairs).toHaveBeenCalledWith(db, {
      threshold: DEFAULT_SIMILARITY_THRESHOLD,
      maxPairs: 5000,
      excludeConsolidationSource: false,
      candidatesSince: null,
    })
  })

  it('returns [] when findSimilarPairs finds nothing', async () => {
    vi.mocked(findSimilarPairs).mockResolvedValue([])
    const db = {} as any
    const rows = await querySimilarPairs(db, 0.9, null)
    expect(rows).toEqual([])
  })
})

// ============================================================
// querySimilarPairs() — legacy O(N^2) self-join path
// (SIMILARITY_SCAN_LEGACY is read once at module load, so this path is
// exercised via a fresh module instance loaded with the env var set.)
// ============================================================

describe('querySimilarPairs() — legacy path (SIMILARITY_SCAN_LEGACY=1)', () => {
  const ORIGINAL_ENV = process.env.SIMILARITY_SCAN_LEGACY

  beforeEach(() => {
    vi.resetModules()
    process.env.SIMILARITY_SCAN_LEGACY = '1'
  })

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SIMILARITY_SCAN_LEGACY
    } else {
      process.env.SIMILARITY_SCAN_LEGACY = ORIGINAL_ENV
    }
    vi.resetModules()
  })

  it('runs the legacy self-join query and renders the expected SQL shape', async () => {
    const legacyRows = [
      { capture_id_a: 'a', capture_id_b: 'b', similarity: '0.95' },
    ]
    const execute = vi.fn().mockImplementation(async (queryArg: unknown) => {
      const { sql: renderedSql, params } = renderSql(queryArg)
      expect(renderedSql).toContain('JOIN captures b ON a.id < b.id')
      expect(renderedSql).toContain("a.pipeline_status = 'complete'")
      expect(renderedSql).toContain('a.embedding IS NOT NULL')
      expect(params).toContain(0.9)
      return { rows: legacyRows }
    })
    const db = { execute } as any

    const mod = await import('../skills/memory-consolidation-query.js')
    const rows = await mod.querySimilarPairs(db, 0.9, null)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(rows).toEqual(legacyRows)
  })

  it('returns [] and logs on a legacy query error (does not throw)', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('connection refused'))
    const db = { execute } as any

    const mod = await import('../skills/memory-consolidation-query.js')
    const rows = await mod.querySimilarPairs(db, 0.9, null)

    expect(rows).toEqual([])
  })
})

// ============================================================
// findConsolidationCandidates() — orchestration
// ============================================================

describe('findConsolidationCandidates()', () => {
  beforeEach(() => {
    vi.mocked(findSimilarPairs).mockReset()
  })

  it('composes querySimilarPairs + buildClusters and returns candidates with defaults applied', async () => {
    const dbPairs: SimilarPair[] = [
      { capture_id_a: 'a', capture_id_b: 'b', similarity: 0.94 },
      { capture_id_a: 'b', capture_id_b: 'c', similarity: 0.96 },
    ]
    vi.mocked(findSimilarPairs).mockResolvedValue(dbPairs)
    const db = {} as any

    const result = await findConsolidationCandidates(db)

    expect(findSimilarPairs).toHaveBeenCalledWith(db, {
      threshold: DEFAULT_SIMILARITY_THRESHOLD,
      maxPairs: 5000,
      excludeConsolidationSource: false,
      candidatesSince: null,
    })
    expect(result.totalPairsFound).toBe(2)
    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0].captureIds).toEqual(['a', 'b', 'c'])
    expect(result.totalClustersFound).toBe(1)
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('honors explicit options: similarityThreshold, minClusterSize, maxClusters, candidatesSince', async () => {
    // 2 disjoint pairs -> 2 clusters of size 2 each; minClusterSize=2 keeps both,
    // maxClusters=1 truncates the returned list but totalClustersFound counts both.
    const dbPairs: SimilarPair[] = [
      { capture_id_a: 'a', capture_id_b: 'b', similarity: 0.99 },
      { capture_id_a: 'x', capture_id_b: 'y', similarity: 0.93 },
    ]
    vi.mocked(findSimilarPairs).mockResolvedValue(dbPairs)
    const db = {} as any
    const since = new Date('2026-05-01T00:00:00.000Z')

    const result = await findConsolidationCandidates(db, {
      similarityThreshold: 0.9,
      minClusterSize: 2,
      maxClusters: 1,
      candidatesSince: since,
    })

    expect(findSimilarPairs).toHaveBeenCalledWith(db, {
      threshold: 0.9,
      maxPairs: 5000,
      excludeConsolidationSource: false,
      candidatesSince: since,
    })
    expect(result.totalClustersFound).toBe(2)
    expect(result.clusters).toHaveLength(1)
    // Higher avgSimilarity cluster (a,b @ 0.99) wins the single maxClusters=1 slot.
    expect(result.clusters[0].captureIds).toEqual(['a', 'b'])
  })

  it('returns empty clusters and zero counts when no similar pairs are found', async () => {
    vi.mocked(findSimilarPairs).mockResolvedValue([])
    const db = {} as any

    const result = await findConsolidationCandidates(db)

    expect(result.clusters).toEqual([])
    expect(result.totalPairsFound).toBe(0)
    expect(result.totalClustersFound).toBe(0)
  })
})
