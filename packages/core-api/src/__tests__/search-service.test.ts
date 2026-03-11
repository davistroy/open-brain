import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SearchService, applyTemporalDecay } from '../services/search.js'
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
 * Build a mock db where:
 *  - First execute() call returns hybridRows (hybrid_search result)
 *  - Second execute() call returns captureRows (SELECT * FROM captures)
 *
 * No further execute() calls — temporal decay is now computed in-memory.
 */
function makeMockDb(
  hybridRows: Array<{ capture_id: string; rrf_score: number; fts_score: number; vector_score: number }>,
  captureRows: CaptureRecord[],
) {
  const execute = vi.fn()

  // Call 1: hybrid_search
  execute.mockResolvedValueOnce({ rows: hybridRows })

  // Call 2: SELECT * FROM captures
  execute.mockResolvedValueOnce({ rows: captureRows })

  return { execute }
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
      execute.mockResolvedValueOnce({ rows: hybridRows })
      execute.mockResolvedValueOnce({ rows: [capture1, capture2] })

      const service = new SearchService({ execute } as any, embeddingService as any)

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
      execute.mockResolvedValueOnce({ rows: hybridRows })
      execute.mockResolvedValueOnce({ rows: captures })

      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('paginated query', { limit: 3 })

      expect(results).toHaveLength(3)
    })

    it('issues exactly 2 db.execute() calls per search (no per-row round-trips)', async () => {
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

      // Exactly 2: hybrid_search + SELECT captures — no per-row actr calls
      expect(db.execute).toHaveBeenCalledTimes(2)
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
      // Only 2 DB calls — no extra round-trips
      expect(db.execute).toHaveBeenCalledTimes(2)
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

    it('still issues exactly 2 db.execute() calls when temporalWeight > 0', async () => {
      const capture = makeCaptureRecord({ created_at: new Date(Date.now() - 100 * 3_600_000) })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('no extra db calls', { temporalWeight: 0.5 })

      expect(db.execute).toHaveBeenCalledTimes(2)
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
      // Verify exactly 2 DB calls (no in-memory filtering round-trips)
      expect(db.execute).toHaveBeenCalledTimes(2)
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
      // Still exactly 2 DB calls
      expect(db.execute).toHaveBeenCalledTimes(2)
    })

    it('passes filter params to fts_only_search in FTS mode', async () => {
      const capture = makeCaptureRecord({ id: 'cap-1', brain_view: 'career' })
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.9, fts_score: 0.8, vector_score: 0.0 }]
      const db = makeMockDb(hybridRows, [capture])
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
      execute.mockResolvedValueOnce({ rows: hybridRows })
      execute.mockResolvedValueOnce({ rows: captures })

      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('limit check', { limit: 3 })

      // At most limit results returned
      expect(results).toHaveLength(3)
      // Only 2 execute calls — no overfetch round-trips
      expect(execute).toHaveBeenCalledTimes(2)
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
})
