/**
 * Tests for lib/api-client.ts
 *
 * Uses MSW v2 (from ../../test/msw-server) to intercept fetch calls.
 * The server is started/stopped in test/setup.ts via beforeAll/afterEach/afterAll.
 * Per-test overrides use server.use(...) to add temporary handlers.
 */

import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/msw-server'
import {
  HttpError,
  buildQueryString,
  capturesApi,
  entitiesApi,
  briefsApi,
  statsApi,
  searchApi,
  synthesizeApi,
  intelligenceApi,
  request,
} from '../api-client'

// ---------------------------------------------------------------------------
// Helper — capture the last request headers seen by MSW
// ---------------------------------------------------------------------------

/** Registers a one-shot override that captures request headers and returns the given body. */
function captureRequestHeaders(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  responseBody: Record<string, unknown> = {},
): Promise<Headers> {
  return new Promise((resolve) => {
    server.use(
      http[method](path, ({ request: req }) => {
        resolve(req.headers)
        return HttpResponse.json(responseBody)
      }),
    )
  })
}

// ---------------------------------------------------------------------------
// 1. X-Open-Brain-Caller header is set on GET requests
// ---------------------------------------------------------------------------

describe('request() — X-Open-Brain-Caller header', () => {
  it('sets X-Open-Brain-Caller: web-ui on GET /api/v1/captures', async () => {
    const headersPromise = captureRequestHeaders('get', '/api/v1/captures', {
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    })
    await capturesApi.list()
    const headers = await headersPromise
    expect(headers.get('x-open-brain-caller')).toBe('web-ui')
  })

  it('sets X-Open-Brain-Caller: web-ui on GET /api/v1/entities', async () => {
    const headersPromise = captureRequestHeaders('get', '/api/v1/entities', {
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    })
    await entitiesApi.list()
    const headers = await headersPromise
    expect(headers.get('x-open-brain-caller')).toBe('web-ui')
  })

  it('sets X-Open-Brain-Caller: web-ui on POST /api/v1/captures', async () => {
    const headersPromise = captureRequestHeaders('post', '/api/v1/captures', {
      id: 'cap-new',
      pipeline_status: 'pending',
      created_at: '2026-04-21T00:00:00.000Z',
    })
    await capturesApi.create({
      content: 'test capture',
      capture_type: 'idea',
      brain_view: 'technical',
    })
    const headers = await headersPromise
    expect(headers.get('x-open-brain-caller')).toBe('web-ui')
  })

  it('sets Content-Type: application/json on POST with body', async () => {
    const headersPromise = captureRequestHeaders('post', '/api/v1/captures', {
      id: 'cap-ct',
      pipeline_status: 'pending',
      created_at: '2026-04-21T00:00:00.000Z',
    })
    await capturesApi.create({
      content: 'ct test',
      capture_type: 'decision',
      brain_view: 'work-internal',
    })
    const headers = await headersPromise
    expect(headers.get('content-type')).toMatch('application/json')
  })
})

// ---------------------------------------------------------------------------
// 2. HttpError thrown for 4xx responses
// ---------------------------------------------------------------------------

describe('HttpError — 4xx responses', () => {
  it('throws HttpError with status 404 for missing capture', async () => {
    server.use(
      http.get('/api/v1/captures/no-such-id', () =>
        HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    )
    const err = await capturesApi.get('no-such-id').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(404)
    expect((err as HttpError).path).toBe('/captures/no-such-id')
  })

  it('HttpError body contains the JSON error object on 404', async () => {
    server.use(
      http.get('/api/v1/captures/bad-id', () =>
        HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    )
    const err = await capturesApi.get('bad-id').catch((e: unknown) => e)
    expect((err as HttpError).body).toMatchObject({ error: 'Not found' })
  })

  it('throws HttpError with status 422 for validation failure', async () => {
    server.use(
      http.post('/api/v1/captures', () =>
        HttpResponse.json({ error: 'Validation failed', fields: ['content'] }, { status: 422 }),
      ),
    )
    const err = await capturesApi
      .create({ content: '', capture_type: 'idea', brain_view: 'personal' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(422)
  })

  it('throws HttpError with status 429 for rate limit exceeded', async () => {
    server.use(
      http.get('/api/v1/stats', () =>
        HttpResponse.json({ error: 'Too many requests' }, { status: 429 }),
      ),
    )
    const err = await statsApi.get().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// 3. HttpError thrown for 5xx responses
// ---------------------------------------------------------------------------

describe('HttpError — 5xx responses', () => {
  it('throws HttpError with status 500 for internal server error', async () => {
    server.use(
      http.get('/api/v1/stats', () =>
        HttpResponse.json({ error: 'Internal server error' }, { status: 500 }),
      ),
    )
    const err = await statsApi.get().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(500)
    expect((err as HttpError).path).toBe('/stats')
  })

  it('throws HttpError with status 503 for service unavailable', async () => {
    server.use(
      http.get('/api/v1/entities', () =>
        HttpResponse.json({ error: 'Service unavailable' }, { status: 503 }),
      ),
    )
    const err = await entitiesApi.list().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(503)
  })

  it('handles plain-text error body on 502', async () => {
    server.use(
      http.get('/api/v1/briefs', () =>
        new HttpResponse('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
      ),
    )
    const err = await briefsApi.list().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(502)
    expect((err as HttpError).body).toBe('Bad Gateway')
  })
})

// ---------------------------------------------------------------------------
// 4. buildQueryString — correct serialization
// ---------------------------------------------------------------------------

describe('buildQueryString()', () => {
  it('returns empty string for empty params', () => {
    expect(buildQueryString({})).toBe('')
  })

  it('skips undefined values', () => {
    expect(buildQueryString({ a: 'x', b: undefined })).toBe('?a=x')
  })

  it('skips null values', () => {
    expect(buildQueryString({ a: 'x', b: null })).toBe('?a=x')
  })

  it('serializes numbers and booleans as strings', () => {
    const qs = buildQueryString({ limit: 20, hybrid: true })
    expect(qs).toBe('?limit=20&hybrid=true')
  })

  it('handles arrays by repeating the key', () => {
    const qs = buildQueryString({ tags: ['a', 'b', 'c'] })
    expect(qs).toBe('?tags=a&tags=b&tags=c')
  })

  it('skips undefined items inside arrays', () => {
    const qs = buildQueryString({ tags: ['x', undefined, 'z'] })
    expect(qs).toContain('tags=x')
    expect(qs).toContain('tags=z')
    expect(qs).not.toContain('undefined')
  })

  it('URL-encodes special characters in values', () => {
    const qs = buildQueryString({ q: 'hello world & more' })
    expect(qs).toBe('?q=hello+world+%26+more')
  })
})

// ---------------------------------------------------------------------------
// 5. Successful response shapes — sanity-check against MSW handlers
// ---------------------------------------------------------------------------

describe('namespace helpers — successful responses', () => {
  it('capturesApi.list() returns items array', async () => {
    const result = await capturesApi.list({ limit: 10 })
    expect(result.items).toBeInstanceOf(Array)
    expect(typeof result.total).toBe('number')
  })

  it('searchApi.search() passes q param and returns results', async () => {
    server.use(
      http.get('/api/v1/search', ({ request: req }) => {
        const url = new URL(req.url)
        const q = url.searchParams.get('q')
        return HttpResponse.json({
          results: q === 'test query' ? [{ capture: { id: 'cap-001' }, score: 0.9 }] : [],
          total: q === 'test query' ? 1 : 0,
          query: q ?? '',
        })
      }),
    )
    const result = await searchApi.search({ q: 'test query' })
    expect(result.results).toHaveLength(1)
    expect(result.results[0].score).toBe(0.9)
  })

  it('synthesizeApi.query() sends POST with body', async () => {
    server.use(
      http.post('/api/v1/synthesize', async ({ request: req }) => {
        const body = await req.json() as { query: string; limit?: number }
        // Actual route response shape: { response: string, capture_count: number }
        return HttpResponse.json({
          response: `Synthesized: ${body.query}`,
          capture_count: 3,
        })
      }),
    )
    const result = await synthesizeApi.query({ query: 'what decisions did I make?', limit: 5 })
    expect(result.response).toContain('what decisions did I make?')
    expect(result.capture_count).toBe(3)
  })

  it('intelligenceApi.summary() returns connections and drift fields', async () => {
    server.use(
      http.get('/api/v1/intelligence/summary', () =>
        HttpResponse.json({ connections: null, drift: null }),
      ),
    )
    const result = await intelligenceApi.summary()
    expect(result).toHaveProperty('connections')
    expect(result).toHaveProperty('drift')
  })
})

// ---------------------------------------------------------------------------
// 6. HttpError — name and message
// ---------------------------------------------------------------------------

describe('HttpError — class properties', () => {
  it('has name "HttpError"', () => {
    const err = new HttpError(404, { error: 'Not found' }, '/captures/x')
    expect(err.name).toBe('HttpError')
  })

  it('message contains status and path', () => {
    const err = new HttpError(500, null, '/stats')
    expect(err.message).toContain('500')
    expect(err.message).toContain('/stats')
  })

  it('is an instance of Error', () => {
    const err = new HttpError(400, null, '/test')
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// 7. request() — raw call with custom path
// ---------------------------------------------------------------------------

describe('request() — raw helper', () => {
  it('prefixes /api/v1 and returns parsed JSON', async () => {
    server.use(
      http.get('/api/v1/health', () =>
        HttpResponse.json({ status: 'healthy' }),
      ),
    )
    const result = await request<{ status: string }>('/health')
    expect(result.status).toBe('healthy')
  })
})

// ---------------------------------------------------------------------------
// 8. briefsApi.patchRead — PATCH /api/v1/briefs/:id
// ---------------------------------------------------------------------------

describe('briefsApi.patchRead()', () => {
  it('sends PATCH with read: true and resolves on 204', async () => {
    server.use(
      http.patch('/api/v1/briefs/brief-001', async ({ request: req }) => {
        const body = await req.json() as { read: boolean }
        if (body.read === true) {
          return new HttpResponse(null, { status: 204 })
        }
        return HttpResponse.json({ error: 'Unexpected body' }, { status: 400 })
      }),
    )
    await expect(briefsApi.patchRead('brief-001', true)).resolves.toBeUndefined()
  })

  it('sends PATCH with read: false for mark-unread', async () => {
    let receivedBody: unknown
    server.use(
      http.patch('/api/v1/briefs/brief-002', async ({ request: req }) => {
        receivedBody = await req.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await briefsApi.patchRead('brief-002', false)
    expect(receivedBody).toMatchObject({ read: false })
  })

  it('throws HttpError 404 when brief does not exist', async () => {
    server.use(
      http.patch('/api/v1/briefs/no-such-brief', () =>
        HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    )
    const err = await briefsApi.patchRead('no-such-brief', true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(404)
  })

  it('sets X-Open-Brain-Caller: web-ui on PATCH', async () => {
    const headersPromise = captureRequestHeaders('patch', '/api/v1/briefs/brief-001', {})
    // MSW 204 handler will already be set by the default handler
    briefsApi.patchRead('brief-001', true).catch(() => { /* 204 response, ignore */ })
    const headers = await headersPromise
    expect(headers.get('x-open-brain-caller')).toBe('web-ui')
  })
})

// ---------------------------------------------------------------------------
// 9. briefsApi.refine — POST /api/v1/briefs/:id/refine
// ---------------------------------------------------------------------------

describe('briefsApi.refine()', () => {
  it('sends POST with instruction and returns job_id', async () => {
    server.use(
      http.post('/api/v1/briefs/brief-001/refine', async ({ request: req }) => {
        const body = await req.json() as { instruction: string }
        return HttpResponse.json({ job_id: `job-${body.instruction}` })
      }),
    )
    const result = await briefsApi.refine('brief-001', 'Shorter')
    expect(result.job_id).toBe('job-Shorter')
  })

  it('throws HttpError 404 when brief does not exist', async () => {
    server.use(
      http.post('/api/v1/briefs/ghost/refine', () =>
        HttpResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    )
    const err = await briefsApi.refine('ghost', 'Longer').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(404)
  })

  it('sets Content-Type: application/json on POST', async () => {
    const headersPromise = captureRequestHeaders(
      'post',
      '/api/v1/briefs/brief-001/refine',
      { job_id: 'job-test' },
    )
    briefsApi.refine('brief-001', 'More formal').catch(() => { /* ignore */ })
    const headers = await headersPromise
    expect(headers.get('content-type')).toMatch('application/json')
  })
})
