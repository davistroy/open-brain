import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { handleQuery } from '../handlers/query.js'
import { isSynthesisRequest } from '../handlers/synthesis.js'
import type { CoreApiClient, SearchResult } from '../lib/core-api-client.js'
import type { Redis } from 'ioredis'
import type { ThreadContext } from '../lib/thread-context.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSay(): SayFn {
  return vi.fn().mockResolvedValue({})
}

function makeMessage(overrides: Partial<Record<string, unknown>> = {}): GenericMessageEvent {
  return {
    type: 'message',
    subtype: undefined,
    channel: 'C1234567890',
    ts: '1234567890.000100',
    text: '? QSR pricing strategy',
    user: 'U111222333',
    thread_ts: undefined,
    ...overrides,
  } as unknown as GenericMessageEvent
}

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'cap-1',
    content: 'Tiered pricing decision for QSR segment based on volume.',
    capture_type: 'decision',
    brain_view: 'work-internal',
    source: 'slack',
    score: 0.88,
    created_at: '2026-03-05T10:00:00Z',
    pre_extracted: { topics: ['pricing', 'QSR'] },
    ...overrides,
  }
}

function makeSearchResponse(results: SearchResult[] = [makeSearchResult()]) {
  return {
    query: 'QSR pricing strategy',
    total: results.length,
    results,
  }
}

function makeCaptureResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-1',
    content: 'Full capture detail — tiered pricing decision for QSR.',
    capture_type: 'decision',
    brain_view: 'work-internal',
    source: 'slack',
    pipeline_status: 'complete',
    tags: ['pricing'],
    created_at: '2026-03-05T10:00:00Z',
    pre_extracted: { topics: ['pricing', 'QSR'], entities: [], sentiment: 'positive' },
    ...overrides,
  }
}

function makeClient(overrides: Partial<CoreApiClient> = {}): CoreApiClient {
  return {
    captures_create: vi.fn(),
    captures_get: vi.fn().mockResolvedValue(makeCaptureResult()),
    search_query: vi.fn().mockResolvedValue(makeSearchResponse()),
    synthesize_query: vi.fn().mockResolvedValue({ response: 'Here is the synthesis.' }),
    stats_get: vi.fn(),
    ...overrides,
  } as unknown as CoreApiClient
}

/**
 * Build a mock ioredis client.
 * By default: get returns null (no cached context), set/del are no-ops.
 */
function makeRedis(overrides: Partial<Record<string, unknown>> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis
}

/** Serialize a ThreadContext as ioredis would store it */
function serializedContext(ctx: ThreadContext): string {
  return JSON.stringify(ctx)
}

// ---------------------------------------------------------------------------
// handleQuery() tests
// ---------------------------------------------------------------------------

describe('handleQuery()', () => {
  let say: SayFn
  let client: CoreApiClient
  let redis: Redis

  beforeEach(() => {
    say = makeSay()
    client = makeClient()
    redis = makeRedis()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // New query — no thread context
  // -------------------------------------------------------------------------

  describe('new query (no thread context)', () => {
    it('calls search_query with extracted text (strips ? prefix)', async () => {
      const msg = makeMessage({ text: '? QSR pricing strategy' })
      await handleQuery(msg, say, client, redis)
      expect(client.search_query).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'QSR pricing strategy' }),
      )
    })

    it('strips leading ? and whitespace from query', async () => {
      const msg = makeMessage({ text: '?   tiered model analysis' })
      await handleQuery(msg, say, client, redis)
      expect(client.search_query).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'tiered model analysis' }),
      )
    })

    it('strips @mention from query text', async () => {
      const msg = makeMessage({ text: '<@UBOTID> what are my recent decisions?' })
      await handleQuery(msg, say, client, redis)
      expect(client.search_query).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'what are my recent decisions?' }),
      )
    })

    it('uses hybrid search_mode', async () => {
      await handleQuery(makeMessage(), say, client, redis)
      expect(client.search_query).toHaveBeenCalledWith(
        expect.objectContaining({ search_mode: 'hybrid' }),
      )
    })

    it('replies in thread with formatted search results', async () => {
      const msg = makeMessage({ ts: '9999999999.000001' })
      await handleQuery(msg, say, client, redis)
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '9999999999.000001' }),
      )
    })

    it('reply includes match percentage', async () => {
      ;(client.search_query as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSearchResponse([makeSearchResult({ score: 0.92 })]),
      )
      await handleQuery(makeMessage(), say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('92%')
    })

    it('stores thread context in Redis with TTL', async () => {
      await handleQuery(makeMessage({ ts: 'ts-abc' }), say, client, redis)
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('ts-abc'),
        expect.any(String),
        'EX',
        expect.any(Number),
      )
    })

    it('thread context TTL is 3600 (1 hour)', async () => {
      await handleQuery(makeMessage(), say, client, redis)
      const setCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(setCall[3]).toBe(3600)
    })

    it('stored context contains the query string', async () => {
      await handleQuery(makeMessage({ text: '? the stored query text' }), say, client, redis)
      const setCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const ctx = JSON.parse(setCall[1] as string) as ThreadContext
      expect(ctx.query).toBe('the stored query text')
    })

    it('stored context starts at page 1', async () => {
      await handleQuery(makeMessage(), say, client, redis)
      const setCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const ctx = JSON.parse(setCall[1] as string) as ThreadContext
      expect(ctx.page).toBe(1)
    })

    it('shows no-results message when search returns empty', async () => {
      ;(client.search_query as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSearchResponse([]),
      )
      await handleQuery(makeMessage({ text: '? nothing found here' }), say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No results found')
    })

    it('shows error message when search_query throws', async () => {
      ;(client.search_query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Search failed 500'),
      )
      await handleQuery(makeMessage(), say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // Thread follow-up — number selection
  // -------------------------------------------------------------------------

  describe('follow-up: number selection', () => {
    const existingContext: ThreadContext = {
      query: 'QSR pricing',
      page: 1,
      results: [
        makeSearchResult({ id: 'cap-1', content: 'First result' }),
        makeSearchResult({ id: 'cap-2', content: 'Second result' }),
        makeSearchResult({ id: 'cap-3', content: 'Third result' }),
      ],
    }

    beforeEach(() => {
      redis = makeRedis({
        get: vi.fn().mockResolvedValue(serializedContext(existingContext)),
      })
    })

    it('calls captures_get with the selected capture ID', async () => {
      const msg = makeMessage({ text: '2', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      expect(client.captures_get).toHaveBeenCalledWith('cap-2')
    })

    it('replies with full capture detail', async () => {
      ;(client.captures_get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeCaptureResult({ id: 'cap-1' }),
      )
      const msg = makeMessage({ text: '1', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      // formatCapture output contains 'Capture Detail'
      expect(call.text).toContain('Capture Detail')
    })

    it('replies with out-of-range message for invalid selection', async () => {
      const msg = makeMessage({ text: '99', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No result #99')
    })

    it('shows error if captures_get fails', async () => {
      ;(client.captures_get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Core API captures.get failed 404: Not found'),
      )
      const msg = makeMessage({ text: '1', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // Thread follow-up — pagination (more)
  // -------------------------------------------------------------------------

  describe('follow-up: "more" pagination', () => {
    const manyResults: SearchResult[] = Array.from({ length: 8 }, (_, i) =>
      makeSearchResult({ id: `cap-${i}`, content: `Result number ${i}` }),
    )

    beforeEach(() => {
      redis = makeRedis({
        get: vi.fn().mockResolvedValue(
          serializedContext({ query: 'QSR', page: 1, results: manyResults }),
        ),
      })
    })

    it('shows page 2 results on "more"', async () => {
      const msg = makeMessage({ text: 'more', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      // Page 2 starts at result 5 (index 5) — numbered 6.
      expect(call.text).toContain('6.')
    })

    it('updates stored page to 2 in Redis', async () => {
      const msg = makeMessage({ text: 'more', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const setCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const ctx = JSON.parse(setCall[1] as string) as ThreadContext
      expect(ctx.page).toBe(2)
    })

    it('replies "No more results" when already on last page', async () => {
      redis = makeRedis({
        get: vi.fn().mockResolvedValue(
          serializedContext({ query: 'QSR', page: 2, results: manyResults }),
        ),
      })
      const msg = makeMessage({ text: 'more', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No more results')
    })

    it('also accepts "next" as a pagination command', async () => {
      const msg = makeMessage({ text: 'next', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      // Should NOT be an error — should show page 2
      expect(call.text).not.toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // Thread follow-up — expired context
  // -------------------------------------------------------------------------

  describe('expired thread context', () => {
    it('replies with expiry message when thread context is missing', async () => {
      redis = makeRedis({ get: vi.fn().mockResolvedValue(null) })
      const msg = makeMessage({ text: '1', thread_ts: 'ts-expired' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('expired')
    })

    it('tells user to send a new query after expiry', async () => {
      redis = makeRedis({ get: vi.fn().mockResolvedValue(null) })
      const msg = makeMessage({ text: 'more', thread_ts: 'ts-expired' })
      await handleQuery(msg, say, client, redis)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('new query')
    })

    it('does not call search_query when thread context is expired', async () => {
      redis = makeRedis({ get: vi.fn().mockResolvedValue(null) })
      const msg = makeMessage({ text: '1', thread_ts: 'ts-expired' })
      await handleQuery(msg, say, client, redis)
      expect(client.search_query).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Thread follow-up — new query within thread
  // -------------------------------------------------------------------------

  describe('new query within existing thread', () => {
    beforeEach(() => {
      redis = makeRedis({
        get: vi.fn().mockResolvedValue(
          serializedContext({
            query: 'old query',
            page: 1,
            results: [makeSearchResult()],
          }),
        ),
      })
    })

    it('treats unrecognized follow-up as a new search', async () => {
      const msg = makeMessage({ text: 'tell me about contract pricing', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      expect(client.search_query).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'tell me about contract pricing' }),
      )
    })

    it('overwrites thread context with new search results', async () => {
      const msg = makeMessage({ text: 'new search terms', thread_ts: 'ts-original' })
      await handleQuery(msg, say, client, redis)
      const setCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]
      const ctx = JSON.parse(setCall[1] as string) as ThreadContext
      expect(ctx.query).toBe('new search terms')
      expect(ctx.page).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Empty / missing text
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('skips messages with empty text', async () => {
      const msg = makeMessage({ text: '' })
      await handleQuery(msg, say, client, redis)
      expect(client.search_query).not.toHaveBeenCalled()
      expect(say).not.toHaveBeenCalled()
    })

    it('skips messages with no text field', async () => {
      const msg = makeMessage({ text: undefined as unknown as string })
      await handleQuery(msg, say, client, redis)
      expect(client.search_query).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// isSynthesisRequest() tests
// ---------------------------------------------------------------------------

describe('isSynthesisRequest()', () => {
  it('returns true for "summarize my work"', () => {
    expect(isSynthesisRequest('summarize my work')).toBe(true)
  })

  it('returns true for "synthesize my QSR notes"', () => {
    expect(isSynthesisRequest('synthesize my QSR notes')).toBe(true)
  })

  it("returns true for \"what's the pattern\"", () => {
    expect(isSynthesisRequest("what's the pattern")).toBe(true)
  })

  it('returns true for "what are my themes"', () => {
    expect(isSynthesisRequest('what are my themes')).toBe(true)
  })

  it('returns true for "give me an overview"', () => {
    expect(isSynthesisRequest('give me an overview')).toBe(true)
  })

  it('returns true for "what have I learned"', () => {
    expect(isSynthesisRequest('what have I learned')).toBe(true)
  })

  it('returns false for a plain search query', () => {
    expect(isSynthesisRequest('QSR pricing strategy')).toBe(false)
  })

  it('returns false for a question without synthesis keywords', () => {
    expect(isSynthesisRequest('what did I decide about pricing?')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isSynthesisRequest('')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isSynthesisRequest('SUMMARIZE my notes')).toBe(true)
  })

  it('returns true for "overall summary"', () => {
    expect(isSynthesisRequest('give me an overall summary of my work')).toBe(true)
  })
})
