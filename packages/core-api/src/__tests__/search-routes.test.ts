import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import { EmbeddingUnavailableError } from '../services/embedding.js'
import type { SearchResult } from '../services/search.js'
import type { CaptureRecord } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock infrastructure dependencies (same pattern as captures-routes.test.ts)
// ---------------------------------------------------------------------------

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    disconnect: vi.fn(),
  })),
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCaptureRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-search-1',
    content: 'A capture about AI and language models',
    content_hash: 'searchhash',
    capture_type: 'idea',
    brain_view: 'technical',
    source: 'api',
    source_metadata: undefined,
    tags: ['ai', 'llm'],
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

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    capture: makeCaptureRecord(),
    score: 0.85,
    ftsScore: 0.7,
    vectorScore: 0.9,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock SearchService factory
// ---------------------------------------------------------------------------

function makeMockSearchService(overrides: Record<string, unknown> = {}) {
  return {
    search: vi.fn().mockResolvedValue([makeSearchResult()]),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/search
// ---------------------------------------------------------------------------

describe('GET /api/v1/search', () => {
  let searchService: ReturnType<typeof makeMockSearchService>

  beforeEach(() => {
    vi.clearAllMocks()
    searchService = makeMockSearchService()
  })

  it('returns 200 with results array and query echo on valid request', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search?q=machine+learning')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.query).toBe('machine learning')
    expect(Array.isArray(body.results)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  it('passes the query string to searchService.search', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search?q=distributed+systems')

    expect(searchService.search).toHaveBeenCalledWith(
      'distributed systems',
      expect.any(Object),
    )
  })

  it('returns 400 when q param is missing', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search')

    expect(res.status).toBe(400)
  })

  it('returns 400 when q param is empty string', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search?q=')

    expect(res.status).toBe(400)
  })

  it('forwards limit query param to searchService.search', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search?q=test&limit=5')

    expect(searchService.search).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ limit: 5 }),
    )
  })

  it('returns 400 for limit > 50', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search?q=test&limit=100')

    expect(res.status).toBe(400)
  })

  it('forwards temporal_weight param to searchService.search', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search?q=test&temporal_weight=0.3')

    expect(searchService.search).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ temporalWeight: 0.3 }),
    )
  })

  it('parses brain_views as comma-delimited list', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search?q=test&brain_views=technical,career')

    expect(searchService.search).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ brainViews: ['technical', 'career'] }),
    )
  })

  it('parses capture_types as comma-delimited list', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search?q=test&capture_types=idea,decision')

    expect(searchService.search).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ captureTypes: ['idea', 'decision'] }),
    )
  })

  it('returns 503 when searchService throws EmbeddingUnavailableError', async () => {
    searchService.search.mockRejectedValueOnce(
      new EmbeddingUnavailableError('LiteLLM/Jetson unreachable'),
    )

    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search?q=failing+query')

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('returns 200 with empty results array when search returns nothing', async () => {
    searchService.search.mockResolvedValueOnce([])

    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search?q=no+matches')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([])
    expect(body.total).toBe(0)
  })

  it('returns 404 when searchService is not registered (no searchService dep)', async () => {
    const app = createApp({})
    const res = await app.request('/api/v1/search?q=test')

    expect(res.status).toBe(404)
  })

  it('returns results containing capture and score fields', async () => {
    const result = makeSearchResult({ score: 0.92 })
    searchService.search.mockResolvedValueOnce([result])

    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search?q=test')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0]).toHaveProperty('capture')
    expect(body.results[0]).toHaveProperty('score')
    expect(body.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/search
// ---------------------------------------------------------------------------

describe('POST /api/v1/search', () => {
  let searchService: ReturnType<typeof makeMockSearchService>

  beforeEach(() => {
    vi.clearAllMocks()
    searchService = makeMockSearchService()
  })

  it('returns 200 with results on valid body', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'AI concepts' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.query).toBe('AI concepts')
    expect(Array.isArray(body.results)).toBe(true)
  })

  it('passes query and options to searchService.search', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'distributed systems',
        limit: 5,
        temporal_weight: 0.2,
        fts_weight: 0.4,
        vector_weight: 0.6,
      }),
    })

    expect(searchService.search).toHaveBeenCalledWith(
      'distributed systems',
      expect.objectContaining({
        limit: 5,
        temporalWeight: 0.2,
        ftsWeight: 0.4,
        vectorWeight: 0.6,
      }),
    )
  })

  it('returns 400 when query field is missing', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when query is empty string', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when limit exceeds maximum of 50', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', limit: 100 }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when search_mode is invalid', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', search_mode: 'invalid-mode' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when temporal_weight is out of range', async () => {
    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', temporal_weight: 1.5 }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 503 when searchService throws EmbeddingUnavailableError', async () => {
    searchService.search.mockRejectedValueOnce(
      new EmbeddingUnavailableError('Embedding service temporarily down'),
    )

    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'failing query' }),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('passes brain_views array to searchService.search', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'career thoughts',
        brain_views: ['career', 'personal'],
      }),
    })

    expect(searchService.search).toHaveBeenCalledWith(
      'career thoughts',
      expect.objectContaining({ brainViews: ['career', 'personal'] }),
    )
  })

  it('passes date range to searchService.search', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'recent captures',
        start_date: '2026-01-01T00:00:00.000Z',
        end_date: '2026-03-01T00:00:00.000Z',
      }),
    })

    expect(searchService.search).toHaveBeenCalledWith(
      'recent captures',
      expect.objectContaining({
        dateFrom: new Date('2026-01-01T00:00:00.000Z'),
        dateTo: new Date('2026-03-01T00:00:00.000Z'),
      }),
    )
  })

  it('applies offset pagination on the results slice', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeSearchResult({ score: 0.9 - i * 0.05, capture: makeCaptureRecord({ id: `cap-${i}` }) }),
    )
    searchService.search.mockResolvedValueOnce(results)

    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'paginated', limit: 2, offset: 2 }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    // Total is the full result count before slice
    expect(body.total).toBe(5)
    // Paginated results should be the 3rd and 4th items (offset=2, limit=2)
    expect(body.results).toHaveLength(2)
    expect(body.results[0].capture.id).toBe('cap-2')
    expect(body.results[1].capture.id).toBe('cap-3')
  })

  it('returns empty results array when search returns nothing', async () => {
    searchService.search.mockResolvedValueOnce([])

    const app = createApp({ searchService: searchService as any })
    const res = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'no matches here' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([])
    expect(body.total).toBe(0)
  })

  it('uses default values for optional fields (limit=10, offset=0, temporal_weight=0)', async () => {
    const app = createApp({ searchService: searchService as any })
    await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'defaults test' }),
    })

    expect(searchService.search).toHaveBeenCalledWith(
      'defaults test',
      expect.objectContaining({
        limit: 10,
        temporalWeight: 0.0,
      }),
    )
  })
})
