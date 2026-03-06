import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SearchService } from '../services/search.js'
import { EmbeddingUnavailableError } from '../services/embedding.js'
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
 *  - Subsequent execute() calls return actr_temporal_score results (one per hybrid row)
 */
function makeMockDb(
  hybridRows: Array<{ capture_id: string; rrf_score: number; fts_score: number; vector_score: number }>,
  captureRows: CaptureRecord[],
  temporalScore = 0.85,
) {
  const execute = vi.fn()

  // Call 1: hybrid_search
  execute.mockResolvedValueOnce({ rows: hybridRows })

  // Call 2: SELECT * FROM captures
  execute.mockResolvedValueOnce({ rows: captureRows })

  // Calls 3..N: actr_temporal_score for each hybrid row
  for (let i = 0; i < hybridRows.length; i++) {
    execute.mockResolvedValueOnce({ rows: [{ final_score: temporalScore - i * 0.01 }] })
  }

  return { execute }
}

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

    it('applies actr_temporal_score to compute the final score', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture], 0.75)
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('query')

      // Final score comes from actr_temporal_score mock = 0.75
      expect(results[0].score).toBe(0.75)
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
      // actr_temporal_score: cap-1 gets 0.6, cap-2 gets 0.9
      execute.mockResolvedValueOnce({ rows: [{ final_score: 0.6 }] })
      execute.mockResolvedValueOnce({ rows: [{ final_score: 0.9 }] })

      const service = new SearchService({ execute } as any, embeddingService as any)

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
      // One actr call per row
      for (let i = 0; i < 5; i++) {
        execute.mockResolvedValueOnce({ rows: [{ final_score: 0.9 - i * 0.05 }] })
      }

      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('paginated query', { limit: 3 })

      expect(results).toHaveLength(3)
    })

    it('falls back to rrf_score when actr_temporal_score returns no rows', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.77, fts_score: 0.6, vector_score: 0.85 }]

      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: hybridRows })
      execute.mockResolvedValueOnce({ rows: [capture] })
      execute.mockResolvedValueOnce({ rows: [] }) // no final_score row

      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('fallback test')

      expect(results[0].score).toBe(0.77) // falls back to rrf_score
    })
  })

  // -------------------------------------------------------------------------
  // temporalWeight = 0.0 (cold start) vs non-zero
  // -------------------------------------------------------------------------

  describe('temporalWeight', () => {
    it('passes temporalWeight=0.0 (cold start default) to the actr SQL call', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture])
      const service = new SearchService(db as any, embeddingService as any)

      await service.search('cold start query') // no temporalWeight option = default 0.0

      // The third execute call is actr_temporal_score — we can't easily inspect
      // sql template args directly, but we verify the call count is correct
      expect(db.execute).toHaveBeenCalledTimes(3) // hybrid + captures + actr
    })

    it('accepts non-zero temporalWeight and still returns results', async () => {
      const capture = makeCaptureRecord()
      const hybridRows = [{ capture_id: 'cap-1', rrf_score: 0.8, fts_score: 0.6, vector_score: 0.9 }]
      const db = makeMockDb(hybridRows, [capture], 0.65)
      const service = new SearchService(db as any, embeddingService as any)

      const results = await service.search('temporal weighted query', { temporalWeight: 0.3 })

      expect(results).toHaveLength(1)
      expect(results[0].score).toBe(0.65) // from mock
    })
  })

  // -------------------------------------------------------------------------
  // Filter application
  // -------------------------------------------------------------------------

  describe('filter application', () => {
    function buildMultiCaptureSetup() {
      const captures = [
        makeCaptureRecord({ id: 'cap-1', brain_view: 'technical', capture_type: 'idea', captured_at: new Date('2026-02-01T00:00:00Z') }),
        makeCaptureRecord({ id: 'cap-2', brain_view: 'career', capture_type: 'decision', captured_at: new Date('2026-01-01T00:00:00Z') }),
        makeCaptureRecord({ id: 'cap-3', brain_view: 'personal', capture_type: 'reflection', captured_at: new Date('2026-03-01T00:00:00Z') }),
      ]

      const hybridRows = captures.map((c, i) => ({
        capture_id: c.id!,
        rrf_score: 0.9 - i * 0.1,
        fts_score: 0.8,
        vector_score: 0.85,
      }))

      const execute = vi.fn()
      execute.mockResolvedValueOnce({ rows: hybridRows })
      execute.mockResolvedValueOnce({ rows: captures })
      // actr calls — assign descending scores
      captures.forEach((_, i) => {
        execute.mockResolvedValueOnce({ rows: [{ final_score: 0.9 - i * 0.1 }] })
      })

      return { execute, captures }
    }

    it('filters by brainViews when provided', async () => {
      const { execute } = buildMultiCaptureSetup()
      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('filter test', { brainViews: ['technical'] })

      expect(results).toHaveLength(1)
      expect(results[0].capture.brain_view).toBe('technical')
    })

    it('filters by multiple brainViews', async () => {
      const { execute } = buildMultiCaptureSetup()
      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('multi-view filter', { brainViews: ['technical', 'career'] })

      expect(results).toHaveLength(2)
      const views = results.map(r => r.capture.brain_view)
      expect(views).toContain('technical')
      expect(views).toContain('career')
    })

    it('filters by captureTypes when provided', async () => {
      const { execute } = buildMultiCaptureSetup()
      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('type filter', { captureTypes: ['decision'] })

      expect(results).toHaveLength(1)
      expect(results[0].capture.capture_type).toBe('decision')
    })

    it('filters by dateFrom (inclusive)', async () => {
      const { execute } = buildMultiCaptureSetup()
      const service = new SearchService({ execute } as any, embeddingService as any)

      // Only cap-3 (2026-03-01) is on or after 2026-02-15
      const results = await service.search('date from filter', {
        dateFrom: new Date('2026-02-15T00:00:00Z'),
      })

      expect(results).toHaveLength(1)
      expect(results[0].capture.id).toBe('cap-3')
    })

    it('filters by dateTo (inclusive)', async () => {
      const { execute } = buildMultiCaptureSetup()
      const service = new SearchService({ execute } as any, embeddingService as any)

      // cap-1 (2026-02-01) and cap-2 (2026-01-01) are on or before 2026-02-01
      const results = await service.search('date to filter', {
        dateTo: new Date('2026-02-01T23:59:59Z'),
      })

      expect(results).toHaveLength(2)
      const ids = results.map(r => r.capture.id)
      expect(ids).toContain('cap-1')
      expect(ids).toContain('cap-2')
    })

    it('applies combined filters (brainViews + dateFrom)', async () => {
      const { execute } = buildMultiCaptureSetup()
      const service = new SearchService({ execute } as any, embeddingService as any)

      // Only cap-3 is personal AND >= 2026-02-15
      const results = await service.search('combined filter', {
        brainViews: ['personal'],
        dateFrom: new Date('2026-02-15T00:00:00Z'),
      })

      expect(results).toHaveLength(1)
      expect(results[0].capture.id).toBe('cap-3')
    })

    it('returns empty array when filters exclude all results', async () => {
      const { execute } = buildMultiCaptureSetup()
      const service = new SearchService({ execute } as any, embeddingService as any)

      const results = await service.search('no match filter', {
        brainViews: ['work-internal'], // none of the captures are this view
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
