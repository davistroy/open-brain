import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { capturesApi, statsApi, searchApi, entitiesApi, pipelineApi } from '../api'

// Helper to create a mock fetch Response
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(ok ? '' : String(body)),
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('capturesApi.list', () => {
  it('calls the captures endpoint and returns data', async () => {
    const payload = { data: [], total: 0, limit: 20, offset: 0 }
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(payload))

    const result = await capturesApi.list({ limit: 20 })
    expect(result).toEqual(payload)
    expect(fetch).toHaveBeenCalledOnce()
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/captures')
    expect(url).toContain('limit=20')
  })

  it('throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse('Not Found', false, 404))
    await expect(capturesApi.list()).rejects.toThrow('API 404')
  })
})

describe('capturesApi.get', () => {
  it('fetches a single capture by id', async () => {
    const capture = { id: 'abc', content: 'test capture' }
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(capture))

    const result = await capturesApi.get('abc')
    expect(result).toEqual(capture)
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/captures/abc')
  })
})

describe('statsApi.get', () => {
  it('fetches brain stats', async () => {
    const stats = { total_captures: 42, by_source: {}, by_type: {}, by_view: {} }
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(stats))

    const result = await statsApi.get()
    expect(result).toEqual(stats)
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/stats')
  })
})

describe('searchApi.search', () => {
  it('posts search filters and returns results', async () => {
    const searchResult = { captures: [], total: 0, query: 'hello', hybrid: true }
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(searchResult))

    const result = await searchApi.search({ q: 'hello', hybrid: true })
    expect(result).toEqual(searchResult)

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/search')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ q: 'hello', hybrid: true })
  })
})

describe('entitiesApi.list', () => {
  it('builds query string from params', async () => {
    const payload = { data: [], total: 0 }
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(payload))

    await entitiesApi.list({ type_filter: 'person', sort_by: 'mentions', limit: 10 })
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('type_filter=person')
    expect(url).toContain('sort_by=mentions')
    expect(url).toContain('limit=10')
  })
})

describe('pipelineApi.health', () => {
  it('fetches pipeline health', async () => {
    const health = { queues: { ingestion: { waiting: 0, active: 1, failed: 0 } } }
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(health))

    const result = await pipelineApi.health()
    expect(result).toEqual(health)
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/pipeline/health')
  })
})
