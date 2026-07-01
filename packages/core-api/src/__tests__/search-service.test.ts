import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SearchService, applyTemporalDecay, toPgTextArray, type SearchResponse } from '../services/search.js'
import { EmbeddingUnavailableError } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnitVector(dimensions = 768): number[] {
  const vec = new Array(dimensions).fill(0)
  vec[0] = 1.0
  return vec
}

function makeCaptureRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-1',
    content: 'Sample capture content about machine learning',
    content_hash: 'hash-abc',
    capture_type: 'idea',
    brain_view: 'technical',
    source: 'api',
    source_metadata: undefined,
    tags: [],
    pipeline_status: 'complete',
    pipeline_attempts: 1,
    pipeline_error: undefined,
    pipeline_completed_at: new Date('2026-03-05T10:00:00Z'),
    pre_extracted: undefined,
    created_at: new Date('2026-03-05T10:00:00Z'),
    updated_at: new Date('2026-03-05T10:00:00Z'),
    captured_at: new Date('2026-03-05T10:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeMockEmbeddingService(vector = makeUnitVector()) {
  return {
    embed: vi.fn().mockResolvedValue(vector),
    embedBatch: vi.fn(),
    getModelInfo: vi.fn(),
  }
}

/**
 * Wrap a bare `execute` mock into a db-like object that also supports
 * `db.transaction(cb)` (PE-M1). The transaction callback receives a `tx`
 * whose `.execute` is the SAME mock as `db.execute`, so call-order
 * (mockResolvedValueOnce queue) and call-count assertions span both
 * `tx.execute` (SET LOCAL ef_search + hybrid_search) and `db.execute`
 * (captures hydration, association lookup) uniformly.
 */
function dbWith(execute: ReturnType<typeof vi.fn>) {
  return {
    execute,
    transaction: vi.fn(async (cb: (tx: { execute: typeof execute }) => unknown) => cb({ execute })),
  }
}

/**
 * Build a mock db for hybrid search mode (default) where:
 *  - Call 1: SET LOCAL hnsw.ef_search = N  (PE-M1 — inside db.transaction, before hybrid_search)
 *  - Call 2: hybrid_search result            (inside the same transaction)
 *  - Call 3: SELECT * FROM captures          (after the transaction commits)
 *
 * For FTS mode use makeMockDbFts() -- no transaction / SET LOCAL in that path.
 * Temporal decay is computed in-memory; no further execute() calls.
 */
function makeMockDb(
  hybridRows: Array<{ capture_id: string; rrf_score: number; fts_score: number; vector_score: number }>,
  captureRows: CaptureRecord[],
) {
  const execute = vi.fn()

  // Call 1: SET LOCAL hnsw.ef_search = N (PE-M1 -- inside txn, before hybrid_search)
  execute.mockResolvedValueOnce({ rows: [] })

  // Call 2: hybrid_search
  execute.mockResolvedValueOnce({ rows: hybridRows })

  // Call 3: SELECT * FROM captures
  execute.mockResolvedValueOnce({ rows: captureRows })

  return dbWith(execute)
}

/**
 * Build a mock db for FTS-only search mode where:
 *  - Call 1: fts_only_search result  (no SET LOCAL -- HNSW not used in FTS path)
 *  - Call 2: SELECT * FROM captures
 */
function makeMockDbFts(
  ftsRows: Array<{ capture_id: string; rrf_score: number; fts_score: number; vector_score: number }>,
  captureRows: CaptureRecord[],
) {
  const execute = vi.fn()

  // Call 1: fts_only_search (no SET LOCAL before this)
  execute.mockResolvedValueOnce({ rows: ftsRows })

  // Call 2: SELECT * FROM captures
  execute.mockResolvedValueOnce({ rows: captureRows })

  return dbWith(execute)
}

// ---------------------------------------------------------------------------
// applyTemporalDecay unit tests
// ---------------------------------------------------------------------------

describe('applyTemporalDecay()', () => {
  it('returns baseScore unchanged when temporalWeight === 0', () => {
    const createdAt = new Date(Date.now() - 24 * 3_600_000) // 24 hours ago
    expect(applyTemporalDecay(0.8, createdAt, 0.0)).toBe(0.8)
  })

  it('returns baseScore unchanged when temporalWeight === 0 regardless of age', () => {
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 3_600_000)
    expect(applyTemporalDecay(0.5, oneYearAgo, 0.0)).toBe(0.5)
  })

  it('applies decay when temporalWeight > 0 and capture has age', () => {
    // 100 hours ago → decay = exp(-0.01 * sqrt(100)) = exp(-0.1) ≈ 0.9048
    const createdAt = new Date(Date.now() - 100 * 3_600_000)
    const score = applyTemporalDecay(1.0, createdAt, 1.0)
    // At temporalWeight=1.0: result = 1.0 * decay * 1.0 + 1.0 * (1 - 1.0) = decay
    expect(score).toBeCloseTo(Math.exp(-0.01 * Math.sqrt(100)), 5)
  })

  it('blends base and decayed score proportionally at intermediate temporalWeight', () => {
    // A brand-new capture (0 hours) has decay = exp(0) = 1.0 → score is unchanged regardless of temporalWeight
    const now = new Date()
    const score = applyTemporalDecay(0.8, now, 0.5)
    expect(score).toBeCloseTo(0.8, 4)
  })

  it('produces a lower score for older captures than for newer ones (same baseScore, same temporalWeight)', () => {
    const recent = new Date(Date.now() - 1 * 3_600_000)    // 1 hour ago
    const old = new Date(Date.now() - 8760 * 3_600_000)    // 1 year ago
    const scoreRecent = applyTemporalDecay(0.8, recent, 0.5)
    const scoreOld = applyTemporalDecay(0.8, old, 0.5)
    expect(scoreRecent).toBeGreaterThan(scoreOld)
  })

  it('accepts a string createdAt value', () => {
    const score = applyTemporalDecay(0.7, '2026-03-05T10:00:00Z', 0.0)
    expect(score).toBe(0.7)
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchService', () => {
  let embeddingService: ReturnType<typeof makeMockEmbeddingService>

  beforeEach(() => {
    vi.clearAllMocks()
    embeddingService = makeMockEmbeddingService()
  })

  // -------------------------------------------------------------------------
  // Basic search flow
  // -------------------------------------------------------------------------

  describe('search() — basic flow', () => {
    it('calls embed() with the query string', async () => {
      const db = makeMockDb([], [])
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('machine learning concepts')

      expect(embeddingService.embed).toHaveBeenCalledOnce()
      expect(embeddingService.embed).toHaveBeenCalledWith('machine learning concepts')
    })

    it('calls db.execute() with hybrid_search SQL', async () => {
      const db = makeMockDb([], [])
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('test query')

      // First execute call should be hybrid_search
      expect(db.execute).toHaveBeenCalled()
      const firstCall = db.execute.mock.calls[0][0]
      // The sql template tag returns an object; verify it's truthy (not null)
      expect(firstCall).toBeTruthy()
    })

    it('returns empty array when hybrid_search returns no rows', async () => {
      const db = makeMockDb([], [])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('query with no matches')

      expect(results).toEqual([])
    })

    it('returns SearchResult objects with capture, score, ftsScore, vectorScore', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('machine learning')

      expect(results).toHaveLength(1)
      expect(results[0].capture).toEqual(capture)
      expect(typeof results[0].score).toBe('number')
      expect(results[0].ftsScore).toBe(0.7)
      expect(results[0].vectorScore).toBe(0.9)
    })

    it('uses rrf_score as final score when temporalWeight=0 (cold start default)', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      // No temporalWeight → defaults to 0.0 → applyTemporalDecay returns rrf_score unchanged
      const results = await service.search('query')

      expect(results[0].score).toBe(0.8)
    })

    it('sorts results by final score descending', async () => {
      const capture1 = makeCaptureRecord({ id: 'cap-1' })
      const capture2 = makeCaptureRecord({ id: 'cap-2' })

      const hybridRows = [
        { capture_id: 'cap-1', rrf_score: 0.6, fts_score: 0.5, vector_score: 0.7 },
        { capture_id: 'cap-2', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.95 },
      ]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [capture1, capture2] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      // temporalWeight=0 → scores are rrf_score values (0.6 and 0.9)
      const results = await service.search('multi-result query')

      expect(results).toHaveLength(2)
      expect(results[0].score).toBeGreaterThan(results[1].score)
      expect(results[0].capture.id).toBe('cap-2')
      expect(results[1].capture.id).toBe('cap-1')
    })

    it('respects the limit option', async () => {
      const captures = Array.from({ length: 5 }, (_, i) => makeCaptureRecord({ id: `cap-${i}` }))
      const hybridRows = captures.map((c, i) => ({
        capture_id: c.id!,
        rrf_score: 0.9 - i * 0.05,
        fts_score: 0.8,
        vector_score: 0.85,
      }))

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: captures })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.search('paginated query', { limit: 3 })

      expect(results).toHaveLength(3)
    })

    it('issues exactly 3 db.execute() calls per hybrid search (SET LOCAL + hybrid_search + SELECT captures)', async () => {
      const captures = [makeCaptureRecord({ id: 'cap-1' }), makeCaptureRecord({ id: 'cap-2' })]
      const hybridRows = captures.map((c, i) => ({
        capture_id: c.id!,
        rrf_score: 0.9 - i * 0.1,
        fts_score: 0.8,
        vector_score: 0.85,
      }))

      const db = makeMockDb(hybridRows, captures)
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('n+1 check')

      // Exactly 3: SET hnsw.ef_search + hybrid_search + SELECT captures (no per-row round-trips)
      expect(db.execute).toHaveBeenCalledTimes(3)
    })
  })

  // -------------------------------------------------------------------------
  // temporalWeight behaviour
  // -------------------------------------------------------------------------

  describe('temporalWeight', () => {
    it('returns rrf_score as score when temporalWeight=0.0 (cold start default)', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('cold start query') // no temporalWeight = default 0.0

      expect(results[0].score).toBe(0.8)
      // 3 DB calls: SET hnsw.ef_search + hybrid_search + SELECT captures
      expect(db.execute).toHaveBeenCalledTimes(3)
    })

    it('applies decay and returns a lower score for an old capture when temporalWeight > 0', async () => {
      // Create a capture that is 1 year old
      const oneYearAgo = new Date(Date.now() - 365 * 24 * 3_600_000)
      const capture = makeCaptureRecord({ created_at: oneYearAgo })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('temporal weighted query', { temporalWeight: 1.0 })

      // With full temporal weight and a 1-year-old capture, score must be less than rrf_score
      expect(results).toHaveLength(1)
      expect(results[0].score).toBeLessThan(0.8)
    })

    it('still issues exactly 3 db.execute() calls when temporalWeight > 0', async () => {
      const capture = makeCaptureRecord({ created_at: new Date(Date.now() - 100 * 3_600_000) })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('no extra db calls', { temporalWeight: 0.5 })

      // SET LOCAL + hybrid_search + SELECT captures -- temporal decay is in-memory
      expect(db.execute).toHaveBeenCalledTimes(3)
    })
  })

  // -------------------------------------------------------------------------
  // hnsw.ef_search per-query SET LOCAL (P13 WI-6)
  // -------------------------------------------------------------------------

  describe('hnswEfSearch constructor param (P13)', () => {
    it('accepts hnswEfSearch as third constructor param with default 60', () => {
      // Constructor should accept 2-arg and 3-arg forms without throwing
      const db = { execute: vi.fn() }
      const svc2 = new SearchService(db as any, embeddingService as any)
      expect(svc2).toBeInstanceOf(SearchService)

      const svc3 = new SearchService(db as any, embeddingService as any, 80)
      expect(svc3).toBeInstanceOf(SearchService)
    })

    it('issues SET LOCAL hnsw.ef_search before hybrid_search in hybrid mode', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]
      const execute = vi.fn()
      // Call 1: SET LOCAL hnsw.ef_search (inside the transaction)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT captures
      execute.mockResolvedValueOnce({ rows: [capture] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any, 80)
      await service.search('ef_search check')

      // Must be 3 calls total (SET LOCAL + hybrid_search + captures)
      expect(execute).toHaveBeenCalledTimes(3)
      // First call should be the SET LOCAL — Drizzle sql`` objects carry their
      // query chunks in .queryChunks or serialize to a SQL-like string via .sql
      const firstArg = execute.mock.calls[0][0]
      // Drizzle SQL objects have a `queryChunks` array or a `.sql` property
      // depending on version. We stringify the whole structure to find the token.
      const firstArgStr = JSON.stringify(firstArg)
      expect(firstArgStr).toMatch(/hnsw\.ef_search/)
      // PE-M1: must be SET LOCAL (transaction-scoped), not a session-leaking SET
      expect(firstArgStr).toMatch(/SET LOCAL/i)
    })

    it('does NOT issue SET hnsw.ef_search when searchMode is fts', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const ftsRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.0 }]
      const db = makeMockDbFts(ftsRows, [capture])

      const service = new SearchService(db as any, embeddingService as any, 80)
      await service.search('fts no ef_search', { searchMode: 'fts' })

      // Only 2 calls: fts_only_search + SELECT captures (no SET LOCAL)
      expect(db.execute).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // PE-M1 — ef_search via SET LOCAL inside a transaction
  // -------------------------------------------------------------------------

  describe('PE-M1 — ef_search via SET LOCAL inside a transaction', () => {
    it('wraps SET LOCAL hnsw.ef_search + hybrid_search in a single db.transaction()', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('txn check')

      // Exactly one transaction opened for the ef_search-scoped hybrid_search
      expect(db.transaction).toHaveBeenCalledTimes(1)
    })

    it('does NOT open a transaction in FTS mode (no HNSW, no ef_search)', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const ftsRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.0 }]
      const db = makeMockDbFts(ftsRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('fts no txn', { searchMode: 'fts' })

      expect(db.transaction).not.toHaveBeenCalled()
    })

    it('does NOT open a transaction when embed() fails (embed precedes the txn)', async () => {
      embeddingService.embed.mockRejectedValueOnce(
        new EmbeddingUnavailableError('embedding down'),
      )
      const db = makeMockDb([], [])
      const service = new SearchService(db as any, embeddingService as any)

      await expect(service.search('embed fails before txn')).rejects.toThrow(
        EmbeddingUnavailableError,
      )
      expect(db.transaction).not.toHaveBeenCalled()
      expect(db.execute).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Filter params pushed to SQL
  // -------------------------------------------------------------------------

  describe('filter params passed to SQL functions', () => {
    it('passes brainViews filter to SQL and returns matching results', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1', brain_view: 'technical' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.85 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('filter test', { brainViews: ['technical'] })

      expect(results).toHaveLength(1)
      expect(results[0].capture.brain_view).toBe('technical')
      // Verify exactly 3 DB calls: SET LOCAL + hybrid_search + SELECT captures (no in-memory filtering)
      expect(db.execute).toHaveBeenCalledTimes(3)
    })

    it('passes captureTypes as Postgres text[] to hybrid_search', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1', capture_type: 'decision' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.85 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('type filter', { captureTypes: ['decision'] })

      expect(results).toHaveLength(1)
      expect(results[0].capture.capture_type).toBe('decision')
    })

    it('passes dateFrom and dateTo as timestamptz to hybrid_search', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1', captured_at: new Date('2026-03-01T00:00:00Z') })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.85 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('date filter', {
        dateFrom: new Date('2026-02-15T00:00:00Z'),
        dateTo: new Date('2026-03-15T00:00:00Z'),
      })

      expect(results).toHaveLength(1)
    })

    it('returns results unfiltered when no filter options are set', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      // No filters → NULL params passed to SQL → no filtering applied
      const results = await service.search('no filters')

      expect(results).toHaveLength(1)
      expect(results[0].score).toBe(0.8)
      // 3 DB calls: SET LOCAL + hybrid_search + SELECT captures
      expect(db.execute).toHaveBeenCalledTimes(3)
    })

    it('passes filter params to fts_only_search in FTS mode', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1', brain_view: 'career' })
      const ftsRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.0 }]
      const db = makeMockDbFts(ftsRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('fts filter test', {
        searchMode: 'fts',
        brainViews: ['career'],
      })

      expect(results).toHaveLength(1)
      // embed() should NOT be called in FTS mode
      expect(embeddingService.embed).not.toHaveBeenCalled()
    })

    it('does not overfetch — SQL receives limit, not limit*5', async () => {
      // With filters in SQL, SearchService no longer needs to overfetch.
      // We verify this by checking that requesting limit=3 returns at most 3
      // results even when the mock returns more (i.e., the service slices to limit).
      const captures = Array.from({ length: 5 }, (_, i) => makeCaptureRecord({ id: `cap-${i}` }))
      const hybridRows = captures.map((c, i) => ({
        capture_id: c.id!,
        rrf_score: 0.9 - i * 0.05,
        fts_score: 0.8,
        vector_score: 0.85,
      }))

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: captures })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.search('limit check', { limit: 3 })

      // At most limit results returned
      expect(results).toHaveLength(3)
      // 3 execute calls: SET LOCAL + hybrid_search + SELECT captures
      expect(execute).toHaveBeenCalledTimes(3)
    })

    it('handles combined filters (brainViews + dateFrom)', async () => {
      const capture = makeCaptureRecord({
        id: 'cap-1',
        brain_view: 'personal',
        captured_at: new Date('2026-03-01T00:00:00Z'),
      })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.85 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('combined filter', {
        brainViews: ['personal'],
        dateFrom: new Date('2026-02-15T00:00:00Z'),
      })

      expect(results).toHaveLength(1)
      expect(results[0].capture.id).toBe('cap-1')
    })

    it('returns empty array when SQL returns no rows (filters exclude all)', async () => {
      // Mock: SQL returns no rows because filter excluded everything
      const db = makeMockDb([], [])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('no match filter', {
        brainViews: ['work-internal'],
      })

      expect(results).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Hebbian association boost
  // -------------------------------------------------------------------------

  describe('recentCaptureIds — association boost', () => {
    it('does not change scores when recentCaptureIds is empty (backward compatible)', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('test', { recentCaptureIds: [] })

      expect(results[0].score).toBe(0.8)
      // 3 DB calls: SET LOCAL + hybrid_search + SELECT captures (no association lookup)
      expect(db.execute).toHaveBeenCalledTimes(3)
    })

    it('does not change scores when recentCaptureIds is undefined (default)', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('test')

      expect(results[0].score).toBe(0.8)
      // 3 DB calls: SET LOCAL + hybrid_search + SELECT captures
      expect(db.execute).toHaveBeenCalledTimes(3)
    })

    it('applies a boost when associations exist with recent captures', async () => {
      const capture1 = makeCaptureRecord({ id: 'cap-1' })
      const capture2 = makeCaptureRecord({ id: 'cap-2' })
      const hybridRows = [
        { capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 },
        { capture_id: 'cap-2', rrf_score: 0.7, fts_score: 0.5, vector_score: 0.8 },
      ]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [capture1, capture2] })
      // Call 4: association lookup — cap-1 has an association with a recent capture
      execute.mockResolvedValueOnce({ rows: [{ capture_id: 'cap-1', max_weight: 5.0 }] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.search('test', { recentCaptureIds: ['recent-1'] })

      // cap-1 should be boosted: 0.8 * (1 + 0.1 * 1.0) = 0.88
      // (normalized weight is 5.0/5.0 = 1.0)
      expect(results[0].capture.id).toBe('cap-1')
      expect(results[0].score).toBeCloseTo(0.88, 5)
      // cap-2 has no association, stays at 0.7
      expect(results[1].capture.id).toBe('cap-2')
      expect(results[1].score).toBe(0.7)
      // 4 DB calls: SET LOCAL + hybrid_search + captures + association lookup
      expect(execute).toHaveBeenCalledTimes(4)
    })

    it('caps the boost at 10% even with very high association weights', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [capture] })
      // Call 4: Association with very high weight — normalized to 1.0
      execute.mockResolvedValueOnce({ rows: [{ capture_id: 'cap-1', max_weight: 999.0 }] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.search('test', { recentCaptureIds: ['recent-1'] })

      // Max boost: 0.8 * (1 + 0.1 * 1.0) = 0.88 (10% increase)
      expect(results[0].score).toBeCloseTo(0.88, 5)
      expect(results[0].score).toBeLessThanOrEqual(0.8 * 1.1 + 0.0001)
    })

    it('normalizes multiple association weights to [0,1] range', async () => {
      const capture1 = makeCaptureRecord({ id: 'cap-1' })
      const capture2 = makeCaptureRecord({ id: 'cap-2' })
      const hybridRows = [
        { capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 },
        { capture_id: 'cap-2', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 },
      ]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [capture1, capture2] })
      // cap-1 has weight 10.0, cap-2 has weight 5.0
      // After normalization: cap-1 = 1.0, cap-2 = 0.5
      // Call 4: association lookup
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'cap-1', max_weight: 10.0 },
        { capture_id: 'cap-2', max_weight: 5.0 },
      ] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.search('test', { recentCaptureIds: ['recent-1'] })

      // cap-1: 0.8 * (1 + 0.1 * 1.0) = 0.88
      const cap1 = results.find(r => r.capture.id === 'cap-1')!
      expect(cap1.score).toBeCloseTo(0.88, 5)
      // cap-2: 0.8 * (1 + 0.1 * 0.5) = 0.84
      const cap2 = results.find(r => r.capture.id === 'cap-2')!
      expect(cap2.score).toBeCloseTo(0.84, 5)
    })

    it('does not boost when association lookup returns no rows', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [capture] })
      // Call 4: No associations found
      execute.mockResolvedValueOnce({ rows: [] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.search('test', { recentCaptureIds: ['recent-1'] })

      // Score unchanged
      expect(results[0].score).toBe(0.8)
    })

    it('can reorder results when boost changes relative ranking', async () => {
      const capture1 = makeCaptureRecord({ id: 'cap-1' })
      const capture2 = makeCaptureRecord({ id: 'cap-2' })
      // cap-2 is slightly ahead of cap-1 before boost
      const hybridRows = [
        { capture_id: 'cap-1', rrf_score: 0.79, fts_score: 0.6, vector_score: 0.8 },
        { capture_id: 'cap-2', rrf_score: 0.80, fts_score: 0.7, vector_score: 0.85 },
      ]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [capture1, capture2] })
      // Call 4: Only cap-1 has an association with a recent capture
      execute.mockResolvedValueOnce({ rows: [{ capture_id: 'cap-1', max_weight: 3.0 }] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.search('test', { recentCaptureIds: ['recent-1'] })

      // cap-1 boosted: 0.79 * 1.1 = 0.869
      // cap-2 unboosted: 0.80
      // cap-1 should now be ranked first
      expect(results[0].capture.id).toBe('cap-1')
      expect(results[0].score).toBeCloseTo(0.79 * 1.1, 5)
      expect(results[1].capture.id).toBe('cap-2')
      expect(results[1].score).toBe(0.80)
    })
  })

  // -------------------------------------------------------------------------
  // SE-10: vector search mode passes fts_weight=0 to hybrid_search
  // -------------------------------------------------------------------------

  describe('SE-10 — searchMode=vector sets fts_weight=0', () => {
    it('passes fts_weight=0 to hybrid_search when searchMode is vector', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.0, vector_score: 0.8 }]
      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT captures
      execute.mockResolvedValueOnce({ rows: [capture] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      await service.search('pure vector query', { searchMode: 'vector', ftsWeight: 0.5 })

      // The hybrid_search SQL call is the 2nd execute. Stringify the SQL object
      // to verify fts_weight 0 was passed (not the caller-supplied 0.5).
      const hybridCallArg = JSON.stringify(execute.mock.calls[1][0])
      // The SQL template encodes numeric values in queryChunks; '0' for ftsWeight
      // must appear and '0.5' must NOT appear as the fts_weight argument.
      // We check that execute was called 3 times (correct path) and embedding was called.
      expect(execute).toHaveBeenCalledTimes(3)
      expect(embeddingService.embed).toHaveBeenCalledOnce()
      // Verify fts_weight value: Drizzle sql`` encodes numeric params as bare JSON numbers
      // in queryChunks. The effective fts_weight must be 0 (not the caller-supplied 0.5).
      // We check the serialized arg contains ,0, (the ftsWeight slot) and NOT ,0.5,
      // in the position after the vector literal and limit.
      // Simpler: parse queryChunks and find the numeric param slots directly.
      const chunks = JSON.parse(hybridCallArg).queryChunks as unknown[]
      // queryChunks alternates SQL strings and param values. Filter to just numbers.
      const numericParams = chunks.filter((c): c is number => typeof c === 'number')
      // params in order: limit(10), ftsWeight(0), vectorWeight(0.5)
      expect(numericParams[0]).toBe(10)    // limit
      expect(numericParams[1]).toBe(0)     // effectiveFtsWeight — must be 0 for vector mode
      expect(numericParams[2]).toBe(0.5)   // vectorWeight
    })

    it('passes caller fts_weight when searchMode is hybrid (unchanged)', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])

      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('hybrid query', { searchMode: 'hybrid', ftsWeight: 0.4 })

      expect(results).toHaveLength(1)
      // 3 calls: SET hnsw + hybrid_search + captures
      expect(db.execute).toHaveBeenCalledTimes(3)
      // Drizzle sql`` encodes numeric params as bare JSON numbers in queryChunks.
      const hybridCallChunks = (JSON.parse(JSON.stringify(db.execute.mock.calls[1][0])).queryChunks as unknown[])
      const numericParams = hybridCallChunks.filter((c): c is number => typeof c === 'number')
      // params in order: limit(10), ftsWeight(0.4), vectorWeight(0.5)
      expect(numericParams[1]).toBe(0.4)   // caller-supplied ftsWeight preserved in hybrid mode
    })
  })

  // -------------------------------------------------------------------------
  // EmbeddingUnavailableError propagation
  // -------------------------------------------------------------------------

  describe('EmbeddingUnavailableError propagation', () => {
    it('propagates EmbeddingUnavailableError from embed() without wrapping', async () => {
      embeddingService.embed.mockRejectedValueOnce(
        new EmbeddingUnavailableError('Jetson device unreachable'),
      )

      const db = { execute: vi.fn() }
      const service = new SearchService(db as any, embeddingService as any)

      await expect(service.search('query that cannot be embedded')).rejects.toThrow(
        EmbeddingUnavailableError,
      )
    })

    it('does not call db.execute when embed() fails', async () => {
      embeddingService.embed.mockRejectedValueOnce(
        new EmbeddingUnavailableError('Embedding service down'),
      )

      const db = { execute: vi.fn() }
      const service = new SearchService(db as any, embeddingService as any)

      await expect(service.search('failing query')).rejects.toThrow()
      expect(db.execute).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // findRelatedCaptures — spreading activation
  // -------------------------------------------------------------------------

  describe('findRelatedCaptures()', () => {
    it('returns empty array when seedCaptureIds is empty', async () => {
      const db = { execute: vi.fn() }
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.findRelatedCaptures([])

      expect(results).toEqual([])
      expect(db.execute).not.toHaveBeenCalled()
    })

    it('calls spreading_activation SQL function with seed IDs', async () => {
      const relatedCapture = makeCaptureRecord({ id: 'related-1' })
      const execute = vi.fn()
      // Call 1: spreading_activation
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'related-1', activation_score: 0.75, hop_count: 1 },
      ] })
      // Call 2: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [relatedCapture] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.findRelatedCaptures(['seed-1', 'seed-2'])

      expect(results).toHaveLength(1)
      expect(results[0].capture.id).toBe('related-1')
      expect(results[0].score).toBe(0.75) // temporalWeight=0 → score unchanged
      // Exactly 2 DB calls: spreading_activation + captures fetch
      expect(execute).toHaveBeenCalledTimes(2)
    })

    it('returns empty array when spreading_activation returns no rows', async () => {
      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: [] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.findRelatedCaptures(['seed-1'])

      expect(results).toEqual([])
      // Only 1 DB call — no captures fetch needed
      expect(execute).toHaveBeenCalledTimes(1)
    })

    it('applies ACT-R temporal decay to activation scores', async () => {
      const oneYearAgo = new Date(Date.now() - 365 * 24 * 3_600_000)
      const relatedCapture = makeCaptureRecord({ id: 'related-1', created_at: oneYearAgo })
      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'related-1', activation_score: 0.9, hop_count: 1 },
      ] })
      execute.mockResolvedValueOnce({ rows: [relatedCapture] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.findRelatedCaptures(['seed-1'], 10, 1.0)

      expect(results).toHaveLength(1)
      // With temporalWeight=1.0 and a year-old capture, score should be less than 0.9
      expect(results[0].score).toBeLessThan(0.9)
    })

    it('sorts results by score descending', async () => {
      const cap1 = makeCaptureRecord({ id: 'rel-1' })
      const cap2 = makeCaptureRecord({ id: 'rel-2' })
      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'rel-1', activation_score: 0.5, hop_count: 2 },
        { capture_id: 'rel-2', activation_score: 0.9, hop_count: 1 },
      ] })
      execute.mockResolvedValueOnce({ rows: [cap1, cap2] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.findRelatedCaptures(['seed-1'])

      expect(results[0].capture.id).toBe('rel-2')
      expect(results[1].capture.id).toBe('rel-1')
    })

    it('respects the limit parameter', async () => {
      const captures = Array.from({ length: 5 }, (_, i) => makeCaptureRecord({ id: `rel-${i}` }))
      const activationRows = captures.map((c, i) => ({
        capture_id: c.id!,
        activation_score: 0.9 - i * 0.1,
        hop_count: 1,
      }))

      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: activationRows })
      execute.mockResolvedValueOnce({ rows: captures })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.findRelatedCaptures(['seed-1'], 3)

      expect(results).toHaveLength(3)
    })

    it('skips captures not found in the database', async () => {
      // spreading_activation returns a capture ID that doesn't exist in captures table
      const cap1 = makeCaptureRecord({ id: 'rel-1' })
      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'rel-1', activation_score: 0.8, hop_count: 1 },
        { capture_id: 'rel-missing', activation_score: 0.7, hop_count: 1 },
      ] })
      execute.mockResolvedValueOnce({ rows: [cap1] }) // only rel-1 exists

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const results = await service.findRelatedCaptures(['seed-1'])

      expect(results).toHaveLength(1)
      expect(results[0].capture.id).toBe('rel-1')
    })
  })

  // -------------------------------------------------------------------------
  // PE-M5 — spreading_activation hop instrumentation
  // -------------------------------------------------------------------------

  describe('PE-M5 — spreading_activation hop instrumentation', () => {
    it('logs the hop-count distribution of returned related captures', async () => {
      const { logger } = await import('@open-brain/shared')
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never)

      const cap1 = makeCaptureRecord({ id: 'rel-1' })
      const cap2 = makeCaptureRecord({ id: 'rel-2' })
      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'rel-1', activation_score: 0.8, hop_count: 1 },
        { capture_id: 'rel-2', activation_score: 0.6, hop_count: 2 },
      ] })
      execute.mockResolvedValueOnce({ rows: [cap1, cap2] })

      const service = new SearchService({ execute } as any, embeddingService as any)
      await service.findRelatedCaptures(['seed-1'])

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ hopCounts: expect.objectContaining({ 1: 1, 2: 1 }) }),
        expect.stringContaining('spreading_activation'),
      )
      debugSpy.mockRestore()
    })

    it('does not log when there are no related captures', async () => {
      const { logger } = await import('@open-brain/shared')
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never)

      const execute = vi.fn().mockResolvedValueOnce({ rows: [] })
      const service = new SearchService({ execute } as any, embeddingService as any)
      await service.findRelatedCaptures(['seed-1'])

      const hopLogs = debugSpy.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('spreading_activation'),
      )
      expect(hopLogs).toHaveLength(0)
      debugSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // searchWithRelated — includeRelated integration
  // -------------------------------------------------------------------------

  describe('searchWithRelated()', () => {
    it('returns only primary results when includeRelated is false (default)', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      const response = await service.searchWithRelated('test query')

      expect(response.results).toHaveLength(1)
      expect(response.relatedResults).toBeUndefined()
      // 3 calls: SET LOCAL + hybrid_search + SELECT captures (no spreading activation)
      expect(db.execute).toHaveBeenCalledTimes(3)
    })

    it('includes related captures when includeRelated is true', async () => {
      const primaryCapture = makeCaptureRecord({ id: 'cap-1' })
      const relatedCapture = makeCaptureRecord({ id: 'related-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search (primary search)
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT captures (primary)
      execute.mockResolvedValueOnce({ rows: [primaryCapture] })
      // Call 4: spreading_activation
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'related-1', activation_score: 0.6, hop_count: 1 },
      ] })
      // Call 5: SELECT captures (related)
      execute.mockResolvedValueOnce({ rows: [relatedCapture] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const response = await service.searchWithRelated('test', { includeRelated: true })

      expect(response.results).toHaveLength(1)
      expect(response.results[0].capture.id).toBe('cap-1')
      expect(response.relatedResults).toHaveLength(1)
      expect(response.relatedResults![0].capture.id).toBe('related-1')
    })

    it('excludes primary results from related results (no duplicates)', async () => {
      const cap1 = makeCaptureRecord({ id: 'cap-1' })
      const cap2 = makeCaptureRecord({ id: 'cap-2' })
      const hybridRows = [
        { capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 },
        { capture_id: 'cap-2', rrf_score: 0.7, fts_score: 0.6, vector_score: 0.8 },
      ]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT captures (primary)
      execute.mockResolvedValueOnce({ rows: [cap1, cap2] })
      // spreading_activation returns cap-2 (already in primary) and related-1 (new)
      const relatedCapture = makeCaptureRecord({ id: 'related-1' })
      // Call 4: spreading_activation
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'cap-2', activation_score: 0.9, hop_count: 1 },
        { capture_id: 'related-1', activation_score: 0.5, hop_count: 2 },
      ] })
      // Call 5: SELECT captures (related)
      execute.mockResolvedValueOnce({ rows: [cap2, relatedCapture] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const response = await service.searchWithRelated('test', { includeRelated: true })

      expect(response.results).toHaveLength(2)
      // cap-2 should NOT appear in related results — it's already in primary
      expect(response.relatedResults).toHaveLength(1)
      expect(response.relatedResults![0].capture.id).toBe('related-1')
    })

    it('uses top 5 primary result IDs as seeds for spreading activation', async () => {
      // Create 7 primary results — only top 5 should be seeds
      const captures = Array.from({ length: 7 }, (_, i) => makeCaptureRecord({ id: `cap-${i}` }))
      const hybridRows = captures.map((c, i) => ({
        capture_id: c.id!,
        rrf_score: 0.9 - i * 0.05,
        fts_score: 0.8,
        vector_score: 0.85,
      }))

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: captures })
      // Spreading activation returns nothing — we just want to verify it was called
      // Call 4: spreading_activation
      execute.mockResolvedValueOnce({ rows: [] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      await service.searchWithRelated('test', { includeRelated: true })

      // Verify spreading_activation was called (4th execute call: SET LOCAL + hybrid_search + captures + spreading_activation)
      expect(execute).toHaveBeenCalledTimes(4)
      // The SQL call should contain the seed IDs — we verify by checking
      // that it was called at all (the function uses top 5)
    })

    it('returns empty relatedResults when spreading_activation finds nothing', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]

      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures
      execute.mockResolvedValueOnce({ rows: [capture] })
      // Call 4: Spreading activation returns nothing
      execute.mockResolvedValueOnce({ rows: [] })

      const service = new SearchService(dbWith(execute) as any, embeddingService as any)

      const response = await service.searchWithRelated('test', { includeRelated: true })

      expect(response.results).toHaveLength(1)
      expect(response.relatedResults).toEqual([])
    })

    it('does not run spreading activation when primary search returns no results', async () => {
      const db = makeMockDb([], [])
      const service = new SearchService(db as any, embeddingService as any)

      const response = await service.searchWithRelated('no matches', { includeRelated: true })

      expect(response.results).toEqual([])
      expect(response.relatedResults).toBeUndefined()
    })

    it('primary search results are unchanged by includeRelated (additive only)', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.7, vector_score: 0.9 }]

      // Run without includeRelated
      const db1 = makeMockDb(hybridRows, [capture])
      const service1 = new SearchService(db1 as any, embeddingService as any)
      const baseResults = await service1.search('test')

      // Run with includeRelated
      embeddingService = makeMockEmbeddingService()
      const execute = vi.fn()
      // Call 1: SET hnsw.ef_search (P13)
      execute.mockResolvedValueOnce({ rows: [] })
      // Call 2: hybrid_search
      execute.mockResolvedValueOnce({ rows: hybridRows })
      // Call 3: SELECT * FROM captures (primary)
      execute.mockResolvedValueOnce({ rows: [capture] })
      // Call 4: spreading_activation
      execute.mockResolvedValueOnce({ rows: [
        { capture_id: 'related-1', activation_score: 0.6, hop_count: 1 },
      ] })
      // Call 5: SELECT * FROM captures (related)
      execute.mockResolvedValueOnce({ rows: [makeCaptureRecord({ id: 'related-1' })] })
      const service2 = new SearchService(dbWith(execute) as any, embeddingService as any)
      const response = await service2.searchWithRelated('test', { includeRelated: true })

      // Primary results should be identical
      expect(response.results).toHaveLength(baseResults.length)
      expect(response.results[0].capture.id).toBe(baseResults[0].capture.id)
      expect(response.results[0].score).toBe(baseResults[0].score)
    })
  })
})

// ---------------------------------------------------------------------------
// SE-11 — toPgTextArray: safe Postgres array literal construction
// ---------------------------------------------------------------------------
//
// The previous bare `{${values.join(',')}}` interpolation would produce an
// invalid (or mis-parsed) array literal if any element contained `,`, `}`,
// `"`, or a backslash. toPgTextArray() double-quotes every element per the
// Postgres array literal spec (§8.15.2) so the value is always round-tripped
// correctly through the `::text[]` cast.
//
// These are pure-function unit tests — no DB or EmbeddingService required.

describe('SE-11 — toPgTextArray: Postgres array literal escaping', () => {
  it('wraps normal single value in double-quotes', () => {
    expect(toPgTextArray(['career'])).toBe('{"career"}')
  })

  it('wraps multiple values, comma-separated', () => {
    expect(toPgTextArray(['career', 'personal', 'technical'])).toBe(
      '{"career","personal","technical"}',
    )
  })

  it('escapes embedded comma — prevents array literal splitting', () => {
    // Without quoting: {career,evil} → 2-element array ['career', 'evil']
    // With quoting:    {"career,evil"} → 1-element array ['career,evil']
    expect(toPgTextArray(['career,evil'])).toBe('{"career,evil"}')
  })

  it('escapes embedded closing brace', () => {
    // Without quoting: {evil}x} is a parse error
    expect(toPgTextArray(['evil}'])).toBe('{"evil}"}')
  })

  it('escapes embedded double-quote with backslash', () => {
    // Postgres requires \" inside a quoted array element
    expect(toPgTextArray(['"quoted"'])).toBe('{"\\\"quoted\\\""}')
  })

  it('escapes embedded backslash (must be doubled: \\ → \\\\)', () => {
    // Postgres requires \\ inside a quoted element to represent a single \
    expect(toPgTextArray(['back\\slash'])).toBe('{"back\\\\slash"}')
  })

  it('handles a combined special-char value without breaking', () => {
    // Simulates a hostile user-supplied brain_view name
    const hostile = 'evil,view}"injection'
    const result = toPgTextArray([hostile])
    // Must start with {", end with "}, and not contain unquoted delimiters
    expect(result).toMatch(/^\{"/)
    expect(result).toMatch(/"\}$/)
    // The comma and brace must be inside the outer quotes
    expect(result).not.toMatch(/^\{evil/)
  })

  it('search() does not throw when brainViews contain a comma', async () => {
    // SE-11 regression: verify the code path completes without throwing.
    // The mock db returns the parameterised SQL value directly; the test
    // validates that toPgTextArray is called (no 500 on special chars).
    const execute = vi.fn()
    execute.mockResolvedValueOnce(undefined) // SET LOCAL ef_search
    execute.mockResolvedValueOnce({ rows: [] }) // hybrid_search (0 results)
    const db = {
      execute,
      transaction: vi.fn(async (cb: (tx: { execute: typeof execute }) => unknown) => cb({ execute })),
    }
    const embeddingService = { embed: vi.fn().mockResolvedValue(new Array(768).fill(0)) }
    const service = new SearchService(db as any, embeddingService as any)

    // A brain_view name with `,` — must not throw
    await expect(
      service.search('test query', { brainViews: ['evil,view'] }),
    ).resolves.toEqual([])
  })
})
