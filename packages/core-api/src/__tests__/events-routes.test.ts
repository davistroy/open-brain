/**
 * Route tests for GET /api/v1/events (SSE endpoint).
 *
 * The events route is a long-lived SSE stream backed by the pgNotify
 * singleton. In unit form we verify:
 *   1. The HTTP handshake succeeds (status 200, correct SSE headers).
 *   2. The stream writes the initial "connected" event.
 *   3. pgNotify.subscribe() is called once the body stream is consumed.
 *   4. The CHANNEL_TO_SSE_EVENT mapping renames upload_status → upload:status.
 *   5. Subscriber callbacks are properly wired (write is called on notify).
 *
 * hono/streaming runs the body callback lazily — subscribe() is called only
 * once the response body is read. Tests that check subscribe() or body content
 * must read from res.body first to trigger the callback.
 *
 * Timing note: after reader.read() resolves with the first chunk (the
 * "connected" event), the stream callback has written data but may not
 * yet have reached pgNotify.subscribe() because the continuation runs in
 * the next microtask. A zero-delay setTimeout flush is required before
 * asserting subscribe() was called or before triggering subscriber callbacks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerEventsRoutes } from '../routes/events.js'
import { makeTestApp } from './helpers.js'

// ---------------------------------------------------------------------------
// Mock pg-notify singleton
// ---------------------------------------------------------------------------
// vi.mock() is hoisted above variable declarations. Use vi.hoisted() to
// declare mock state in the hoisted zone.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let _subscriber: ((payload: { channel: string; data: Record<string, unknown> }) => void) | null = null
  const _unsub = vi.fn()
  const _subscribe = vi.fn().mockImplementation((cb: typeof _subscriber) => {
    _subscriber = cb
    return _unsub
  })
  return {
    subscribe: _subscribe,
    unsub: _unsub,
    getSubscriber: () => _subscriber,
    clearSubscriber: () => {
      _subscriber = null
    },
  }
})

vi.mock('../lib/pg-notify.js', () => ({
  pgNotify: {
    subscribe: mocks.subscribe,
    notify: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp() {
  // Each test creates a fresh app to avoid shared handler state.
  // The pgNotify mock is module-level so subscribe() is shared.
  mocks.clearSubscriber()
  return makeTestApp((app) => {
    registerEventsRoutes(app)
  })
}

/**
 * Request the SSE endpoint and read the initial chunk to trigger the
 * stream body callback (which is where subscribe() is called).
 * Returns the response and reader positioned after the first chunk.
 */
async function connectAndReadFirstChunk(app: ReturnType<typeof buildApp>) {
  const res = await app.request('/api/v1/events')
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  const firstChunk = new TextDecoder().decode(value)
  // After reader.read() resolves, the stream callback continuation (which
  // calls pgNotify.subscribe()) runs in the next microtask. Flush the event
  // loop so the subscriber is registered before callers inspect it.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  return { res, reader, firstChunk }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Reset mock call counts between tests to prevent cross-test pollution.
beforeEach(() => {
  mocks.subscribe.mockClear()
  mocks.unsub.mockClear()
  mocks.clearSubscriber()
})

describe('GET /api/v1/events — SSE handshake', () => {
  it('returns status 200', async () => {
    const app = buildApp()
    const res = await app.request('/api/v1/events')
    expect(res.status).toBe(200)
  })

  it('sets Content-Type: text/event-stream', async () => {
    const app = buildApp()
    const res = await app.request('/api/v1/events')
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
  })

  it('sets Cache-Control: no-cache', async () => {
    const app = buildApp()
    const res = await app.request('/api/v1/events')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('sets X-Accel-Buffering: no to disable nginx proxy buffering', async () => {
    const app = buildApp()
    const res = await app.request('/api/v1/events')
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
  })

  it('writes initial "connected" event as the first chunk in the stream', async () => {
    const app = buildApp()
    const { firstChunk, reader } = await connectAndReadFirstChunk(app)
    reader.cancel()

    expect(firstChunk).toContain('event: connected')
    expect(firstChunk).toContain('"ts"')
  })

  it('calls pgNotify.subscribe() once the body stream is consumed', async () => {
    const app = buildApp()
    // Reading the body forces the stream callback to run, which calls subscribe().
    const { reader } = await connectAndReadFirstChunk(app)
    reader.cancel()

    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(typeof mocks.subscribe.mock.calls[0][0]).toBe('function')
  })
})

describe('GET /api/v1/events — channel-to-SSE-event mapping', () => {
  it('maps upload_status channel → upload:status SSE event name', async () => {
    const app = buildApp()
    const { reader } = await connectAndReadFirstChunk(app)

    // After reading the connected chunk and flushing the event loop,
    // the subscriber is registered.
    const sub = mocks.getSubscriber()
    expect(sub).toBeTruthy()

    // Fire a pg-notify payload on the upload_status channel.
    sub!({ channel: 'upload_status', data: { fileId: 'f-1', status: 'processing' } })

    // Next chunk should carry the remapped SSE event name.
    const { value } = await reader.read()
    reader.cancel()

    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: upload:status')
    expect(text).toContain('"fileId"')
  })

  it('passes through unknown channels verbatim (e.g. capture_created)', async () => {
    const app = buildApp()
    const { reader } = await connectAndReadFirstChunk(app)

    const sub = mocks.getSubscriber()
    expect(sub).toBeTruthy()

    sub!({ channel: 'capture_created', data: { captureId: 'c-1' } })

    const { value } = await reader.read()
    reader.cancel()

    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: capture_created')
    expect(text).toContain('"captureId"')
  })
})
