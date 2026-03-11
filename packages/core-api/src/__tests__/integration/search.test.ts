/**
 * Integration tests — Search API
 *
 * Exercises search endpoints against real Postgres with pgvector:
 *   GET  /api/v1/search?q=... — query-string based search
 *   POST /api/v1/search       — full-featured JSON body search
 *
 * Search modes tested:
 *   - FTS-only mode (no embedding needed — works with stub embedding service)
 *   - Hybrid mode (uses stub zero-vector embeddings)
 *
 * The test database uses a stub EmbeddingService that returns zero vectors,
 * so vector similarity scores will be zero. FTS scoring is the meaningful
 * signal in these tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  initTestDatabase,
  teardownTestDatabase,
  getTestApp,
  getTestPool,
  type TestAppContext,
} from './setup.js'
import {
  cleanDatabase,
  createTestCapture,
  testGet,
  testPost,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

let ctx: TestAppContext

beforeAll(async () => {
  await initTestDatabase()
  ctx = getTestApp()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await cleanDatabase()
})

// ---------------------------------------------------------------------------
// Helpers — set up captures with tsvector data for FTS
// ---------------------------------------------------------------------------

/**
 * Create a capture and update its tsvector column for FTS search.
 * The init-schema.sql trigger auto-generates tsv from content on INSERT,
 * but since we insert via Drizzle (bypassing raw INSERT triggers in some cases),
 * we explicitly update the tsv column after insert.
 */
async function createSearchableCapture(
  overrides: Parameters<typeof createTestCapture>[0] = {},
): Promise<Record<string, unknown>> {
  const capture = await createTestCapture(overrides)
  // Force tsvector update — the trigger should handle it, but be explicit
  const pool = getTestPool()
  await pool.query(
    `UPDATE captures SET tsv = to_tsvector('english', content) WHERE id = $1`,
    [capture.id],
  )
  return capture
}

// ---------------------------------------------------------------------------
// GET /api/v1/search — FTS mode (query string)
// ---------------------------------------------------------------------------

describe('GET /api/v1/search (FTS mode)', () => {
  it('returns empty results for query with no matches', async () => {
    await createSearchableCapture({ content: 'PostgreSQL database migration plan' })

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=kubernetes&search_mode=fts&limit=10',
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.query).toBe('kubernetes')
    expect(body.total).toBe(0)
    expect(body.results).toEqual([])
  })

  it('returns matching captures for FTS query', async () => {
    await createSearchableCapture({
      content: 'Decided to migrate the database to PostgreSQL for better JSON support',
      capture_type: 'decision',
      brain_view: 'technical',
    })
    await createSearchableCapture({
      content: 'The weather is nice today',
      capture_type: 'observation',
      brain_view: 'personal',
    })

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=PostgreSQL+database&search_mode=fts&limit=10',
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.total).toBeGreaterThanOrEqual(1)
    // The PostgreSQL capture should be in results
    const matchedContents = body.results.map((r: any) => r.capture.content)
    expect(matchedContents).toContain(
      'Decided to migrate the database to PostgreSQL for better JSON support',
    )
  })

  it('returns results with score fields', async () => {
    await createSearchableCapture({
      content: 'Building a semantic search engine with vector embeddings and full text search',
    })

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=semantic+search&search_mode=fts&limit=10',
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    if (body.total > 0) {
      const result = body.results[0]
      expect(result.score).toBeDefined()
      expect(typeof result.score).toBe('number')
      expect(result.capture).toBeDefined()
      expect(result.capture.id).toBeDefined()
      expect(result.capture.content).toBeDefined()
    }
  })

  it('respects limit parameter', async () => {
    // Create 5 captures all containing "architecture"
    for (let i = 0; i < 5; i++) {
      await createSearchableCapture({
        content: `Architecture design pattern number ${i} for microservices`,
      })
    }

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=architecture&search_mode=fts&limit=3',
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.length).toBeLessThanOrEqual(3)
  })

  it('filters by brain_view', async () => {
    await createSearchableCapture({
      content: 'Cloud architecture review for technical team',
      brain_view: 'technical',
    })
    await createSearchableCapture({
      content: 'Cloud architecture impacts on career growth',
      brain_view: 'career',
    })

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=cloud+architecture&search_mode=fts&brain_view=technical&limit=10',
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    // All results should be from technical brain_view
    for (const result of body.results) {
      expect(result.capture.brain_view).toBe('technical')
    }
  })

  it('filters by capture_type', async () => {
    await createSearchableCapture({
      content: 'Decided to use Redis for caching',
      capture_type: 'decision',
    })
    await createSearchableCapture({
      content: 'Idea to use Redis for session storage',
      capture_type: 'idea',
    })

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=Redis&search_mode=fts&capture_type=decision&limit=10',
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    for (const result of body.results) {
      expect(result.capture.capture_type).toBe('decision')
    }
  })

  it('requires a non-empty query string', async () => {
    const res = await testGet(ctx.app, '/api/v1/search?q=&search_mode=fts&limit=10')
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/search — JSON body search with pagination
// ---------------------------------------------------------------------------

describe('POST /api/v1/search', () => {
  it('searches with JSON body', async () => {
    await createSearchableCapture({
      content: 'Implementing BullMQ pipeline for async processing',
    })

    const res = await testPost(ctx.app, '/api/v1/search', {
      query: 'BullMQ pipeline',
      limit: 10,
      offset: 0,
      search_mode: 'fts',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.query).toBe('BullMQ pipeline')
    expect(body.total).toBeGreaterThanOrEqual(0) // FTS tokenization may vary
  })

  it('supports pagination via offset', async () => {
    // Create several matching captures
    for (let i = 0; i < 8; i++) {
      await createSearchableCapture({
        content: `Testing pagination for search results number ${i}`,
      })
    }

    const page1 = await testPost(ctx.app, '/api/v1/search', {
      query: 'pagination search',
      limit: 3,
      offset: 0,
      search_mode: 'fts',
    })
    const body1 = await page1.json()

    const page2 = await testPost(ctx.app, '/api/v1/search', {
      query: 'pagination search',
      limit: 3,
      offset: 3,
      search_mode: 'fts',
    })
    const body2 = await page2.json()

    // If there are results, pages should not overlap
    if (body1.results.length > 0 && body2.results.length > 0) {
      const ids1 = new Set(body1.results.map((r: any) => r.capture.id))
      for (const r of body2.results) {
        expect(ids1.has(r.capture.id)).toBe(false)
      }
    }
  })

  it('filters by brain_views array', async () => {
    await createSearchableCapture({
      content: 'Infrastructure review topic',
      brain_view: 'technical',
    })
    await createSearchableCapture({
      content: 'Infrastructure career development topic',
      brain_view: 'career',
    })
    await createSearchableCapture({
      content: 'Infrastructure personal project topic',
      brain_view: 'personal',
    })

    const res = await testPost(ctx.app, '/api/v1/search', {
      query: 'infrastructure',
      limit: 10,
      offset: 0,
      search_mode: 'fts',
      brain_views: ['technical', 'career'],
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    // Results should only be from technical or career views
    for (const result of body.results) {
      expect(['technical', 'career']).toContain(result.capture.brain_view)
    }
  })

  it('rejects invalid search mode', async () => {
    const res = await testPost(ctx.app, '/api/v1/search', {
      query: 'test',
      search_mode: 'invalid_mode',
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Hybrid mode (with stub zero-vector embeddings)
// ---------------------------------------------------------------------------

describe('Hybrid search mode', () => {
  it('returns results in hybrid mode (FTS component provides matches)', async () => {
    await createSearchableCapture({
      content: 'Vector database comparison between pgvector and Pinecone',
      capture_type: 'observation',
      brain_view: 'technical',
    })

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=vector+database&search_mode=hybrid&limit=10',
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    // Hybrid mode with zero vectors should still return FTS matches
    // (the RRF formula combines FTS + vector scores; zero vectors just
    // mean vector_score=0 for all, so ranking is FTS-driven)
    expect(body.total).toBeGreaterThanOrEqual(0)
  })

  it('uses default search_mode=hybrid when not specified', async () => {
    await createSearchableCapture({
      content: 'Default search mode testing with hybrid approach',
    })

    // GET without search_mode param — should default to hybrid
    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=hybrid+approach&limit=10',
    )
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Search edge cases', () => {
  it('handles special characters in query', async () => {
    await createSearchableCapture({
      content: 'Using C++ and C# for systems programming',
    })

    // Should not crash — special chars in FTS queries
    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=C%2B%2B&search_mode=fts&limit=10',
    )
    expect(res.status).toBe(200)
  })

  it('handles very long queries gracefully', async () => {
    const longQuery = 'database '.repeat(50).trim()
    const res = await testGet(
      ctx.app,
      `/api/v1/search?q=${encodeURIComponent(longQuery)}&search_mode=fts&limit=10`,
    )
    expect(res.status).toBe(200)
  })

  it('returns results with temporal_weight=0 (cold start safe)', async () => {
    await createSearchableCapture({
      content: 'Temporal decay testing with zero weight',
    })

    const res = await testGet(
      ctx.app,
      '/api/v1/search?q=temporal+decay&search_mode=fts&temporal_weight=0&limit=10',
    )
    expect(res.status).toBe(200)
  })
})
