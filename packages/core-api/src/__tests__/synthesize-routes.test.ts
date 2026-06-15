/**
 * Unit tests for `POST /api/v1/synthesize`.
 *
 * Phase 3.4 of IMPLEMENTATION_PLAN-ARCH-REVIEW.md. Uses the canonical
 * test helpers (`makeTestApp`, `makeMockService`, `testJson`) so the
 * fixture is self-contained and does not bootstrap the full createApp()
 * with its `pg` / `ioredis` / `fetch` mocks.
 *
 * The synthesize route depends on TWO services (searchService +
 * llmGateway), so we mount it directly via `registerSynthesizeRoutes`
 * inside `makeTestApp`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigError } from '@open-brain/shared'
import type { SearchResult, SearchService } from '../services/search.js'
import type { CaptureRecord, LLMGatewayService } from '@open-brain/shared'
import { registerSynthesizeRoutes } from '../routes/synthesize.js'
import { makeMockService, makeTestApp, testJson } from './helpers.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCaptureRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-syn-1',
    content: 'Synthesizable capture about distributed systems',
    content_hash: 'synhash',
    capture_type: 'idea',
    brain_view: 'technical',
    source: 'api',
    source_metadata: undefined,
    tags: ['ai'],
    pipeline_status: 'complete',
    pipeline_attempts: 1,
    pipeline_error: undefined,
    pipeline_completed_at: new Date('2026-04-15T10:00:00Z'),
    pre_extracted: undefined,
    created_at: new Date('2026-04-15T10:00:00Z'),
    updated_at: new Date('2026-04-15T10:00:00Z'),
    captured_at: new Date('2026-04-15T10:00:00Z'),
    ...overrides,
  }
}

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    capture: makeCaptureRecord(),
    score: 0.88,
    ftsScore: 0.7,
    vectorScore: 0.9,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

function buildApp(
  searchService: ReturnType<typeof makeMockService<SearchService>>,
  llmGateway: ReturnType<typeof makeMockService<LLMGatewayService>>,
) {
  return makeTestApp((app) => {
    registerSynthesizeRoutes(
      app,
      searchService as unknown as SearchService,
      llmGateway as unknown as LLMGatewayService,
    )
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/synthesize', () => {
  let searchService: ReturnType<typeof makeMockService<SearchService>>
  let llmGateway: ReturnType<typeof makeMockService<LLMGatewayService>>

  beforeEach(() => {
    vi.clearAllMocks()
    // SearchService surface used by the route. We only need `search` here;
    // listing both keeps the mock shape close to the real interface.
    searchService = makeMockService<SearchService>(['search', 'searchWithRelated'])
    searchService.search.mockResolvedValue([makeSearchResult()])

    llmGateway = makeMockService<LLMGatewayService>(['completeByTask'])
    llmGateway.completeByTask.mockResolvedValue('A synthesized answer based on captures.')
  })

  // -------------------------------------------------------------------------
  // Zod validation
  // -------------------------------------------------------------------------

  it('returns 400 when query is empty string', async () => {
    const app = buildApp(searchService, llmGateway)
    const { status } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: '' }),
    })

    expect(status).toBe(400)
    expect(searchService.search).not.toHaveBeenCalled()
    expect(llmGateway.completeByTask).not.toHaveBeenCalled()
  })

  it('returns 400 when query field is missing', async () => {
    const app = buildApp(searchService, llmGateway)
    const { status } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ limit: 5 }),
    })

    expect(status).toBe(400)
    expect(searchService.search).not.toHaveBeenCalled()
    expect(llmGateway.completeByTask).not.toHaveBeenCalled()
  })

  it('returns 400 when query exceeds the 2000-character max', async () => {
    const app = buildApp(searchService, llmGateway)
    const { status } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'x'.repeat(2001) }),
    })

    expect(status).toBe(400)
    expect(searchService.search).not.toHaveBeenCalled()
    expect(llmGateway.completeByTask).not.toHaveBeenCalled()
  })

  it('returns 400 when limit is greater than 30', async () => {
    const app = buildApp(searchService, llmGateway)
    const { status } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'valid query', limit: 50 }),
    })

    expect(status).toBe(400)
    expect(searchService.search).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns 200 with the canonical {response, capture_count} shape on success', async () => {
    const app = buildApp(searchService, llmGateway)
    const { status, body } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'What is hybrid search?', limit: 5 }),
    })

    expect(status).toBe(200)
    expect(body).toEqual({
      response: 'A synthesized answer based on captures.',
      capture_count: 1,
    })
    expect(searchService.search).toHaveBeenCalledWith(
      'What is hybrid search?',
      expect.objectContaining({ limit: 5, searchMode: 'hybrid' }),
    )
    expect(llmGateway.completeByTask).toHaveBeenCalledOnce()
  })

  it('uses the default limit of 5 when not provided', async () => {
    const app = buildApp(searchService, llmGateway)
    const { status } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'defaulted query' }),
    })

    expect(status).toBe(200)
    expect(searchService.search).toHaveBeenCalledWith(
      'defaulted query',
      // Default is 5, not 10 (ce1dcad, 2026-05-09): file captures @ 50k chars
      // overflow the 32k Spark context at limit 10.
      expect.objectContaining({ limit: 5, searchMode: 'hybrid' }),
    )
  })

  it('returns the no-captures fallback response when search yields zero results', async () => {
    searchService.search.mockResolvedValueOnce([])

    const app = buildApp(searchService, llmGateway)
    const { status, body } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'no matches anywhere' }),
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({
      capture_count: 0,
      response: expect.stringContaining("couldn't find any captures"),
    })
    // LLM is never called when there are no captures to ground the answer.
    expect(llmGateway.completeByTask).not.toHaveBeenCalled()
  })

  it('routes synthesize calls via the search_synthesis task key', async () => {
    const app = buildApp(searchService, llmGateway)
    await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'task routing check' }),
    })

    expect(llmGateway.completeByTask).toHaveBeenCalledWith(
      expect.any(String),
      'search_synthesis',
      expect.objectContaining({ maxTokens: 1024, temperature: 0.2 }),
    )
  })

  // -------------------------------------------------------------------------
  // Embedding fallback (search_mode hybrid → fts on EmbeddingUnavailableError)
  // -------------------------------------------------------------------------

  it('falls back to FTS-only search when hybrid throws (embedding unavailable)', async () => {
    searchService.search
      .mockRejectedValueOnce(new Error('embedding endpoint unreachable'))
      .mockResolvedValueOnce([makeSearchResult()])

    const app = buildApp(searchService, llmGateway)
    const { status, body } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'fallback test' }),
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({ capture_count: 1 })
    expect(searchService.search).toHaveBeenCalledTimes(2)
    expect(searchService.search).toHaveBeenNthCalledWith(
      1,
      'fallback test',
      expect.objectContaining({ searchMode: 'hybrid' }),
    )
    expect(searchService.search).toHaveBeenNthCalledWith(
      2,
      'fallback test',
      expect.objectContaining({ searchMode: 'fts' }),
    )
    expect(llmGateway.completeByTask).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  it('returns 503 + CONFIG_ERROR when llmGateway throws ConfigError (LLM provider unavailable)', async () => {
    llmGateway.completeByTask.mockRejectedValueOnce(
      new ConfigError('LLM provider unavailable'),
    )

    const app = buildApp(searchService, llmGateway)
    const { status, body } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'gateway down' }),
    })

    expect(status).toBe(503)
    expect(body).toEqual({
      error: 'LLM provider unavailable',
      code: 'CONFIG_ERROR',
    })
  })

  it('returns 500 + INTERNAL_ERROR shape when llmGateway throws an unexpected non-AppError', async () => {
    llmGateway.completeByTask.mockRejectedValueOnce(new Error('boom'))

    const app = buildApp(searchService, llmGateway)
    const { status, body } = await testJson(app, '/api/v1/synthesize', {
      method: 'POST',
      body: JSON.stringify({ query: 'unexpected explosion' }),
    })

    expect(status).toBe(500)
    expect(body).toEqual({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    })
  })
})
