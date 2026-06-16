/**
 * INT-H1 — CoreApiClient resilience: request timeout, bounded idempotent retry,
 * and 409-as-success on capture creation.
 *
 * These tests use fake timers so the 15s timeout budget and inter-attempt
 * backoff never actually elapse in wall-clock time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoreApiClient } from '../lib/core-api-client.js'
import type { CreateCapturePayload } from '../lib/core-api-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

function errResponse(status: number, body = 'Error body') {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: body }),
    text: () => Promise.resolve(body),
  }
}

/** An error shaped like the DOMException AbortSignal.timeout() raises. */
function abortError(): Error {
  const err = new Error('The operation was aborted due to timeout')
  err.name = 'TimeoutError'
  return err
}

const capturePayload: CreateCapturePayload = {
  content: 'Decided to go with tiered pricing',
  capture_type: 'decision',
  brain_view: 'work-internal',
  source: 'slack',
}

/**
 * Drive a request promise to settlement under fake timers without real elapsed
 * time. A no-op catch is attached SYNCHRONOUSLY so an early rejection (during
 * timer advancement) never escapes as an unhandled rejection. `runAllTimersAsync`
 * drains the backoff `setTimeout`s AND flushes the microtask queue between
 * attempts, so the whole retry chain runs to completion. The original promise is
 * returned for assertion.
 */
function settle<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {}) // swallow on a separate branch; original promise untouched
  return promise
}

/** Run the retry/backoff chain to completion (timers + interleaved microtasks). */
async function drain(): Promise<void> {
  // Multiple passes cover up to 2 sequential backoff sleeps plus fetch microtasks.
  await vi.runAllTimersAsync()
  await vi.runAllTimersAsync()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoreApiClient resilience (INT-H1)', () => {
  let client: CoreApiClient
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    vi.useFakeTimers()
    originalFetch = global.fetch
    client = new CoreApiClient('http://core-api:3000')
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('passes an AbortSignal to fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse({ ok: true }))
      global.fetch = mockFetch
      await client.stats_get()
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('rejects a hanging GET with a clear timeout error (no 15s wall-clock wait)', async () => {
      // fetch rejects with an AbortError-like error on every attempt (simulating timeout).
      const mockFetch = vi.fn().mockRejectedValue(abortError())
      global.fetch = mockFetch

      const promise = settle(client.stats_get())
      await drain()

      await expect(promise).rejects.toThrow(/timed out after 15000ms/)
      await expect(promise).rejects.toThrow(/\/api\/v1\/stats/)
    })
  })

  // -------------------------------------------------------------------------
  // Bounded idempotent retry
  // -------------------------------------------------------------------------

  describe('bounded retry (GET only)', () => {
    it('retries a GET that returns 503 twice then 200 → resolves', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(errResponse(503, 'unavailable'))
        .mockResolvedValueOnce(errResponse(503, 'unavailable'))
        .mockResolvedValueOnce(okResponse({ total_captures: 7 }))
      global.fetch = mockFetch

      const promise = settle(client.stats_get())
      await drain()

      const result = await promise
      expect((result as { total_captures: number }).total_captures).toBe(7)
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('retries a GET on network rejection then succeeds', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(okResponse({ total_captures: 3 }))
      global.fetch = mockFetch

      const promise = settle(client.stats_get())
      await drain()

      const result = await promise
      expect((result as { total_captures: number }).total_captures).toBe(3)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('gives up after 3 attempts on persistent GET 503', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errResponse(503, 'unavailable'))
      global.fetch = mockFetch

      const promise = settle(client.stats_get())
      await drain()

      await expect(promise).rejects.toThrow('503')
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('does NOT retry a GET on a 4xx (deterministic)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errResponse(404, 'not found'))
      global.fetch = mockFetch

      const promise = settle(client.stats_get())
      await drain()

      await expect(promise).rejects.toThrow('404')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // Non-idempotent methods are never retried
  // -------------------------------------------------------------------------

  describe('non-idempotent methods', () => {
    it('does NOT retry a POST that returns 503 (called exactly once)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errResponse(503, 'unavailable'))
      global.fetch = mockFetch

      const promise = settle(client.captures_create(capturePayload))
      await drain()

      await expect(promise).rejects.toThrow('503')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry a POST that rejects on the network (called exactly once)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
      global.fetch = mockFetch

      const promise = settle(client.captures_create(capturePayload))
      await drain()

      await expect(promise).rejects.toThrow()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // 409-as-success on capture create
  // -------------------------------------------------------------------------

  describe('captures_create 409-as-success', () => {
    it('resolves (does not throw) when core-api returns 409 with id in body', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          errResponse(409, 'Duplicate capture detected within the last 60 seconds (id: 11111111-2222-3333-4444-555555555555)'),
        )
      global.fetch = mockFetch

      const promise = settle(client.captures_create(capturePayload))
      await drain()

      const result = await promise
      expect(result.id).toBe('11111111-2222-3333-4444-555555555555')
      expect(mockFetch).toHaveBeenCalledTimes(1) // POST is never retried
    })

    it('resolves with a usable CaptureResult when 409 body carries no id', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(errResponse(409, 'Duplicate capture: content already exists'))
      global.fetch = mockFetch

      const promise = settle(client.captures_create(capturePayload))
      await drain()

      const result = await promise
      // id must be present and >= 8 chars so formatCaptureConfirmation's slice(0,8) is safe.
      expect(typeof result.id).toBe('string')
      expect(result.id.length).toBeGreaterThanOrEqual(8)
      expect(result.source).toBe('slack')
    })

    it('still throws on 422 (validation) — not a conflict', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errResponse(422, 'Validation failed'))
      global.fetch = mockFetch

      const promise = settle(client.captures_create(capturePayload))
      await drain()

      await expect(promise).rejects.toThrow('422')
    })

    it('normal 200 path still returns the parsed CaptureResult', async () => {
      const created = {
        id: 'cap-uuid-1',
        content: 'Test capture content',
        capture_type: 'idea',
        brain_view: 'technical',
        source: 'slack',
        pipeline_status: 'pending',
        tags: [],
        created_at: '2026-03-05T10:00:00Z',
      }
      const mockFetch = vi.fn().mockResolvedValue(okResponse(created))
      global.fetch = mockFetch

      const promise = settle(client.captures_create(capturePayload))
      await drain()

      const result = await promise
      expect(result).toEqual(created)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })
})
