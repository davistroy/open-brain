import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoreApiClient } from '../lib/core-api-client.js'
import type {
  CreateCapturePayload,
  SearchPayload,
} from '../lib/core-api-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

function mockFetchError(status: number, body = 'Error body') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: body }),
    text: () => Promise.resolve(body),
  })
}

function makeCaptureResult() {
  return {
    id: 'cap-uuid-1',
    content: 'Test capture content',
    capture_type: 'idea',
    brain_view: 'technical',
    source: 'slack',
    pipeline_status: 'pending',
    tags: [],
    created_at: '2026-03-05T10:00:00Z',
  }
}

function makeSearchResponse() {
  // API returns nested { capture: {...}, score, ftsScore, vectorScore } format.
  // search_query() maps this to the flat SearchResult interface.
  return {
    query: 'QSR pricing',
    total: 2,
    results: [
      {
        capture: {
          id: 'cap-1',
          content: 'Tiered pricing decision for QSR',
          capture_type: 'decision',
          brain_view: 'work-internal',
          source: 'slack',
          pipeline_status: 'embedded',
          tags: [],
          created_at: '2026-03-01T09:00:00Z',
        },
        score: 0.92,
        ftsScore: 0.5,
        vectorScore: 0.92,
      },
      {
        capture: {
          id: 'cap-2',
          content: 'QSR pricing analysis notes',
          capture_type: 'observation',
          brain_view: 'work-internal',
          source: 'api',
          pipeline_status: 'embedded',
          tags: [],
          created_at: '2026-02-28T15:30:00Z',
        },
        score: 0.78,
        ftsScore: 0.3,
        vectorScore: 0.78,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoreApiClient', () => {
  let client: CoreApiClient
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    client = new CoreApiClient('http://core-api:3000')
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Constructor behavior
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('strips trailing slash from base URL', async () => {
      const mockFetch = mockFetchOk(makeCaptureResult())
      global.fetch = mockFetch
      const clientWithSlash = new CoreApiClient('http://core-api:3000/')
      await clientWithSlash.captures_get('cap-1')
      const [url] = mockFetch.mock.calls[0] as [string]
      expect(url).toBe('http://core-api:3000/api/v1/captures/cap-1')
      // Should not have a double-slash after the protocol (e.g., core-api:3000//api/...)
      expect(url.replace('http://', '')).not.toContain('//')
    })

    it('handles URL without trailing slash correctly', async () => {
      const mockFetch = mockFetchOk(makeCaptureResult())
      global.fetch = mockFetch
      await client.captures_get('cap-1')
      const [url] = mockFetch.mock.calls[0] as [string]
      expect(url).toBe('http://core-api:3000/api/v1/captures/cap-1')
    })
  })

  // -------------------------------------------------------------------------
  // captures_create()
  // -------------------------------------------------------------------------

  describe('captures_create()', () => {
    const payload: CreateCapturePayload = {
      content: 'Decided to go with tiered pricing',
      capture_type: 'decision',
      brain_view: 'work-internal',
      source: 'slack',
      metadata: {
        source_metadata: { slack_ts: '1234567890.000100', channel: 'C123', user: 'U456' },
        tags: ['pricing', 'qsr'],
      },
    }

    it('POSTs to /api/v1/captures with correct URL', async () => {
      const mockFetch = mockFetchOk(makeCaptureResult())
      global.fetch = mockFetch
      await client.captures_create(payload)
      const [url] = mockFetch.mock.calls[0] as [string]
      expect(url).toBe('http://core-api:3000/api/v1/captures')
    })

    it('uses POST method', async () => {
      const mockFetch = mockFetchOk(makeCaptureResult())
      global.fetch = mockFetch
      await client.captures_create(payload)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.method).toBe('POST')
    })

    it('sets Content-Type: application/json header', async () => {
      const mockFetch = mockFetchOk(makeCaptureResult())
      global.fetch = mockFetch
      await client.captures_create(payload)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    })

    it('sends payload as JSON body', async () => {
      const mockFetch = mockFetchOk(makeCaptureResult())
      global.fetch = mockFetch
      await client.captures_create(payload)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.content).toBe(payload.content)
      expect(body.capture_type).toBe(payload.capture_type)
      expect(body.brain_view).toBe(payload.brain_view)
      expect(body.source).toBe(payload.source)
    })

    it('returns parsed CaptureResult on success', async () => {
      const expected = makeCaptureResult()
      global.fetch = mockFetchOk(expected)
      const result = await client.captures_create(payload)
      expect(result).toEqual(expected)
    })

    it('throws on 409 Conflict (duplicate)', async () => {
      global.fetch = mockFetchError(409, 'Capture already exists')
      await expect(client.captures_create(payload)).rejects.toThrow('409')
    })

    it('throws on 422 Unprocessable Entity (validation)', async () => {
      global.fetch = mockFetchError(422, 'Validation failed')
      await expect(client.captures_create(payload)).rejects.toThrow('422')
    })

    it('throws on 500 Internal Server Error', async () => {
      global.fetch = mockFetchError(500, 'Internal error')
      await expect(client.captures_create(payload)).rejects.toThrow('500')
    })

    it('includes error status code in thrown message', async () => {
      global.fetch = mockFetchError(503, 'Service unavailable')
      await expect(client.captures_create(payload)).rejects.toThrow('503')
    })
  })

  // -------------------------------------------------------------------------
  // captures_get()
  // -------------------------------------------------------------------------

  describe('captures_get()', () => {
    it('GETs /api/v1/captures/:id', async () => {
      const mockFetch = mockFetchOk(makeCaptureResult())
      global.fetch = mockFetch
      await client.captures_get('cap-uuid-1')
      const [url] = mockFetch.mock.calls[0] as [string]
      expect(url).toBe('http://core-api:3000/api/v1/captures/cap-uuid-1')
    })

    it('returns parsed CaptureResult on success', async () => {
      const expected = makeCaptureResult()
      global.fetch = mockFetchOk(expected)
      const result = await client.captures_get('cap-uuid-1')
      expect(result).toEqual(expected)
    })

    it('throws on 404 Not Found', async () => {
      global.fetch = mockFetchError(404, 'Not found')
      await expect(client.captures_get('nonexistent-id')).rejects.toThrow('404')
    })

    it('throws on 500', async () => {
      global.fetch = mockFetchError(500)
      await expect(client.captures_get('cap-1')).rejects.toThrow('500')
    })
  })

  // -------------------------------------------------------------------------
  // search_query()
  // -------------------------------------------------------------------------

  describe('search_query()', () => {
    const payload: SearchPayload = {
      query: 'QSR pricing strategy',
      limit: 5,
      threshold: 0.6,
      brain_views: ['work-internal'],
      temporal_weight: 0.0,
      search_mode: 'hybrid',
      offset: 0,
    }

    it('POSTs to /api/v1/search', async () => {
      const mockFetch = mockFetchOk(makeSearchResponse())
      global.fetch = mockFetch
      await client.search_query(payload)
      const [url] = mockFetch.mock.calls[0] as [string]
      expect(url).toBe('http://core-api:3000/api/v1/search')
    })

    it('uses POST method', async () => {
      const mockFetch = mockFetchOk(makeSearchResponse())
      global.fetch = mockFetch
      await client.search_query(payload)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.method).toBe('POST')
    })

    it('sends search payload as JSON body', async () => {
      const mockFetch = mockFetchOk(makeSearchResponse())
      global.fetch = mockFetch
      await client.search_query(payload)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.query).toBe(payload.query)
      expect(body.limit).toBe(payload.limit)
      expect(body.search_mode).toBe('hybrid')
    })

    it('returns SearchResponse with results array', async () => {
      const expected = makeSearchResponse()
      global.fetch = mockFetchOk(expected)
      const result = await client.search_query(payload)
      expect(result.query).toBe('QSR pricing')
      expect(result.total).toBe(2)
      expect(result.results).toHaveLength(2)
    })

    it('throws on 400 Bad Request', async () => {
      global.fetch = mockFetchError(400, 'Bad request')
      await expect(client.search_query(payload)).rejects.toThrow('400')
    })

    it('throws on 500', async () => {
      global.fetch = mockFetchError(500)
      await expect(client.search_query(payload)).rejects.toThrow('500')
    })
  })

  // -------------------------------------------------------------------------
  // synthesize_query()
  // -------------------------------------------------------------------------

  describe('synthesize_query()', () => {
    it('POSTs to /api/v1/synthesize', async () => {
      const mockFetch = mockFetchOk({ response: 'Synthesized answer here.' })
      global.fetch = mockFetch
      await client.synthesize_query({ query: 'summarize my QSR work' })
      const [url] = mockFetch.mock.calls[0] as [string]
      expect(url).toBe('http://core-api:3000/api/v1/synthesize')
    })

    it('sends query and optional limit in body', async () => {
      const mockFetch = mockFetchOk({ response: 'Synthesized answer here.' })
      global.fetch = mockFetch
      await client.synthesize_query({ query: 'what are my decisions?', limit: 20 })
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.query).toBe('what are my decisions?')
      expect(body.limit).toBe(20)
    })

    it('returns { response: string }', async () => {
      const expected = { response: 'Here is the synthesized answer.' }
      global.fetch = mockFetchOk(expected)
      const result = await client.synthesize_query({ query: 'summarize' })
      expect(result.response).toBe('Here is the synthesized answer.')
    })

    it('throws on 500', async () => {
      global.fetch = mockFetchError(500)
      await expect(client.synthesize_query({ query: 'anything' })).rejects.toThrow('500')
    })
  })

  // -------------------------------------------------------------------------
  // stats_get()
  // -------------------------------------------------------------------------

  describe('stats_get()', () => {
    const statsResponse = {
      total_captures: 42,
      by_source: { slack: 30, api: 12 },
      by_type: { idea: 15, decision: 10, task: 17 },
      by_view: { technical: 20, work_internal: 12, career: 10 },
      pipeline_health: {
        pending: 5,
        processing: 2,
        complete: 33,
        failed: 2,
      },
    }

    it('GETs /api/v1/stats', async () => {
      const mockFetch = mockFetchOk(statsResponse)
      global.fetch = mockFetch
      await client.stats_get()
      const [url] = mockFetch.mock.calls[0] as [string]
      expect(url).toBe('http://core-api:3000/api/v1/stats')
    })

    it('returns BrainStats with expected shape', async () => {
      global.fetch = mockFetchOk(statsResponse)
      const result = await client.stats_get()
      expect(result.total_captures).toBe(42)
      expect(result.by_source.slack).toBe(30)
      expect(result.pipeline_health.complete).toBe(33)
    })

    it('throws on 500', async () => {
      global.fetch = mockFetchError(500)
      await expect(client.stats_get()).rejects.toThrow('500')
    })
  })
})
