/**
 * Unit tests for ComposioClient quota meter (P03).
 *
 * Tests the checkAndIncrementQuota() behavior in isolation using mocked Redis
 * and Pushover. The execute() method's HTTP calls are stubbed via vi.spyOn
 * on globalThis.fetch so the quota guard runs without real network access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ComposioClient, ComposioQuotaExceededError } from '../composio-client.js'
import type { ComposioRedisClient } from '../composio-client.js'
import type { PushoverService } from '../pushover.js'

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeRedis(startCount = 0): { redis: ComposioRedisClient; incr: ReturnType<typeof vi.fn>; expire: ReturnType<typeof vi.fn> } {
  let counter = startCount
  const incr = vi.fn(async (_key: string) => {
    counter++
    return counter
  })
  const expire = vi.fn(async (_key: string, _seconds: number) => 1)
  return { redis: { incr, expire }, incr, expire }
}

function makePushover(): { pushover: PushoverService; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => {})
  return { pushover: { send, isConfigured: true } as unknown as PushoverService, send }
}

/**
 * SSE body for a successful Composio MCP response.
 * Defined as a string constant — a new Response is created per fetch call
 * because Response bodies can only be consumed once.
 */
const SSE_SUCCESS_BODY =
  'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"successful\\":true,\\"data\\":{\\"results\\":[{\\"response\\":{\\"data\\":{\\"value\\":[]}}}]}}"}]}}\n'

/**
 * Stub globalThis.fetch to return a minimal successful SSE MCP response.
 * Uses mockImplementation (not mockResolvedValue) so each call gets a
 * fresh Response object — Response bodies can only be consumed once.
 */
function stubFetchSuccess(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(SSE_SUCCESS_BODY, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComposioClient quota meter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('A: increments counter on first call; sets TTL once', async () => {
    const { redis, incr, expire } = makeRedis(0)
    const client = new ComposioClient({ apiKey: 'test-key', redis })
    stubFetchSuccess()

    await client.execute('SOME_TOOL', {})

    expect(incr).toHaveBeenCalledOnce()
    expect(incr).toHaveBeenCalledWith(expect.stringMatching(/^composio:monthly_usage:\d{4}-\d{2}$/))
    // count was 1 on first call — TTL must be set
    expect(expire).toHaveBeenCalledOnce()
    expect(expire).toHaveBeenCalledWith(expect.stringMatching(/^composio:monthly_usage:\d{4}-\d{2}$/), 35 * 24 * 60 * 60)
  })

  it('B: TTL is NOT set when count > 1 (key already exists)', async () => {
    // Start at count=1 so second call lands at count=2
    const { redis, incr, expire } = makeRedis(1)
    const client = new ComposioClient({ apiKey: 'test-key', redis })
    stubFetchSuccess()

    await client.execute('SOME_TOOL', {})

    expect(incr).toHaveBeenCalledOnce()
    // count = 2 — TTL must NOT be set again
    expect(expire).not.toHaveBeenCalled()
  })

  it('C: Pushover warn fires at exactly 15,000', async () => {
    // Start at 14,999 so next INCR returns 15,000
    const { redis } = makeRedis(14_999)
    const { pushover, send } = makePushover()
    const client = new ComposioClient({ apiKey: 'test-key', redis, pushover })
    stubFetchSuccess()

    await client.execute('SOME_TOOL', {})

    expect(send).toHaveBeenCalledOnce()
    const call = send.mock.calls[0][0] as { title: string; message: string; priority: number }
    expect(call.title).toBe('Composio Quota Warning')
    // Message contains "15000" (the count) — no locale formatting in the template string
    expect(call.message).toContain('15000')
    expect(call.priority).toBe(1)
  })

  it('D: ComposioQuotaExceededError thrown when count > 19,000', async () => {
    // Start at 19,000 so INCR returns 19,001
    const { redis } = makeRedis(19_000)
    const { pushover, send } = makePushover()
    const client = new ComposioClient({ apiKey: 'test-key', redis, pushover })
    // fetch must NOT be called — the throw happens before ensureInitialized
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // Single call — should throw ComposioQuotaExceededError
    let thrownError: unknown
    try {
      await client.execute('SOME_TOOL', {})
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeInstanceOf(ComposioQuotaExceededError)
    // Message contains the hard-stop limit (19000) — no locale formatting in the template string
    expect((thrownError as Error).message).toContain('19000')

    // Pushover hard-stop alert should fire
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: 'Composio Quota: BLOCKED' }))
    // HTTP should never be called
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('E: no Redis injected — execute proceeds normally (backward compat)', async () => {
    // String-form constructor: no redis, no pushover
    const client = new ComposioClient('test-api-key')
    const fetchSpy = stubFetchSuccess()

    // Should NOT throw — execute runs to completion
    await expect(client.execute('SOME_TOOL', {})).resolves.not.toThrow()
    // fetch was called (API call happened)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('F: Pushover failure does not block execute (error is swallowed)', async () => {
    // Set up at warn threshold so Pushover fires
    const { redis } = makeRedis(14_999)
    const send = vi.fn(async () => {
      throw new Error('Pushover network error')
    })
    const pushover = { send, isConfigured: true } as unknown as PushoverService
    const client = new ComposioClient({ apiKey: 'test-key', redis, pushover })
    stubFetchSuccess()

    // Must NOT throw — Pushover failure is swallowed inside .catch(() => {})
    await expect(client.execute('SOME_TOOL', {})).resolves.not.toThrow()
    expect(send).toHaveBeenCalledOnce()
  })
})
