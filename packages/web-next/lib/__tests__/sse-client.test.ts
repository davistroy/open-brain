/**
 * Tests for SseClient — exponential backoff reconnect, handler subscription,
 * unsubscribe cleanup, and connection_lost synthetic event.
 *
 * jsdom does not ship EventSource, so we provide a fake implementation that
 * exposes imperative controls for simulating open/error/message events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SseClient, type SseEvent } from '../sse-client'

// ---------------------------------------------------------------------------
// Fake EventSource
// ---------------------------------------------------------------------------

type EventListenerFn = (event: MessageEvent) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []

  url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  private namedListeners: Map<string, EventListenerFn[]> = new Map()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: EventListenerFn): void {
    const list = this.namedListeners.get(type) ?? []
    list.push(fn)
    this.namedListeners.set(type, list)
  }

  removeEventListener(type: string, fn: EventListenerFn): void {
    const list = this.namedListeners.get(type) ?? []
    this.namedListeners.set(
      type,
      list.filter((f) => f !== fn),
    )
  }

  close(): void {
    // Mark as closed — nothing else to do in the fake.
  }

  // --- Test helpers --------------------------------------------------------

  /** Simulate a successful open. */
  simulateOpen(): void {
    this.onopen?.()
  }

  /** Simulate an error (triggers onerror handler). */
  simulateError(): void {
    this.onerror?.()
  }

  /** Dispatch a named SSE event to all registered listeners. */
  simulateEvent(type: string, data: Record<string, unknown>): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    const list = this.namedListeners.get(type) ?? []
    for (const fn of list) fn(event)
  }

  /** Dispatch a generic message event. */
  simulateMessage(data: Record<string, unknown>): void {
    const event = new MessageEvent('message', { data: JSON.stringify(data) })
    this.onmessage?.(event)
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  // Replace global EventSource with our fake.
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function latestInstance(): FakeEventSource {
  const inst = FakeEventSource.instances.at(-1)
  if (!inst) throw new Error('No FakeEventSource instances created')
  return inst
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SseClient — start / stop', () => {
  it('creates an EventSource on start()', () => {
    const client = new SseClient('/api/v1/events')
    client.start()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/v1/events')
    client.stop()
  })

  it('does not create a second EventSource when start() is called twice', () => {
    const client = new SseClient()
    client.start()
    client.start()
    expect(FakeEventSource.instances).toHaveLength(1)
    client.stop()
  })

  it('stop() closes the EventSource and prevents reconnect', () => {
    const client = new SseClient()
    client.start()

    const es = latestInstance()
    const closeSpy = vi.spyOn(es, 'close')

    client.stop()
    expect(closeSpy).toHaveBeenCalledOnce()

    // Simulate error after stop — no new instance should be created.
    es.simulateError()
    vi.runAllTimers()
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('uses default URL when none provided', () => {
    const client = new SseClient()
    client.start()
    expect(FakeEventSource.instances[0].url).toBe('/api/v1/events')
    client.stop()
  })
})

describe('SseClient — handler subscription', () => {
  it('delivers named events to all registered handlers', () => {
    const client = new SseClient()
    client.start()

    const received: SseEvent[] = []
    client.on((evt) => received.push(evt))

    latestInstance().simulateEvent('capture_created', { id: '123' })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ type: 'capture_created', data: { id: '123' } })

    client.stop()
  })

  it('delivers events to multiple handlers', () => {
    const client = new SseClient()
    client.start()

    const r1: SseEvent[] = []
    const r2: SseEvent[] = []
    client.on((e) => r1.push(e))
    client.on((e) => r2.push(e))

    latestInstance().simulateEvent('skill_complete', { skill: 'weekly-brief' })
    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)

    client.stop()
  })

  it('unsubscribe stops delivery without affecting other handlers', () => {
    const client = new SseClient()
    client.start()

    const r1: SseEvent[] = []
    const r2: SseEvent[] = []
    const unsub = client.on((e) => r1.push(e))
    client.on((e) => r2.push(e))

    unsub()

    latestInstance().simulateEvent('pipeline_complete', { capture_id: 'abc' })
    expect(r1).toHaveLength(0) // unsubscribed — receives nothing
    expect(r2).toHaveLength(1) // still subscribed

    client.stop()
  })

  it('on() returns a cleanup function — calling it twice is safe', () => {
    const client = new SseClient()
    client.start()

    const received: SseEvent[] = []
    const unsub = client.on((e) => received.push(e))

    unsub()
    unsub() // second call must not throw

    latestInstance().simulateEvent('brief_created', {})
    expect(received).toHaveLength(0)

    client.stop()
  })

  it('delivers generic message events', () => {
    const client = new SseClient()
    client.start()

    const received: SseEvent[] = []
    client.on((e) => received.push(e))

    latestInstance().simulateMessage({ id: 'msg-1' })
    expect(received).toHaveLength(1)

    client.stop()
  })
})

describe('SseClient — exponential backoff reconnect', () => {
  it('schedules first reconnect after 1s on error', () => {
    const client = new SseClient()
    client.start()
    expect(FakeEventSource.instances).toHaveLength(1)

    latestInstance().simulateError()
    expect(FakeEventSource.instances).toHaveLength(1) // no new instance yet

    vi.advanceTimersByTime(1_000)
    expect(FakeEventSource.instances).toHaveLength(2) // reconnected

    client.stop()
  })

  it('follows the full backoff schedule: 1s, 2s, 4s, 8s, 30s', () => {
    const client = new SseClient()
    client.start()

    const delays = [1_000, 2_000, 4_000, 8_000, 30_000]
    let _elapsed = 0

    for (let attempt = 0; attempt < delays.length; attempt++) {
      latestInstance().simulateError()

      // Advance just before the expected delay — no new connection yet.
      vi.advanceTimersByTime(delays[attempt] - 1)
      expect(FakeEventSource.instances).toHaveLength(attempt + 1)

      // Advance the final millisecond — new connection created.
      vi.advanceTimersByTime(1)
      _elapsed += delays[attempt]

      if (attempt < delays.length - 1) {
        // Not yet exhausted — a new EventSource should be created.
        expect(FakeEventSource.instances).toHaveLength(attempt + 2)
      }
    }

    client.stop()
  })

  it('resets attempt counter after a successful open', () => {
    const client = new SseClient()
    client.start()

    // First error — schedules reconnect at 1s.
    latestInstance().simulateError()
    vi.advanceTimersByTime(1_000) // 2nd EventSource created

    // Successful open resets counter.
    latestInstance().simulateOpen()
    expect(FakeEventSource.instances).toHaveLength(2)

    // Second error — should again schedule at 1s (reset counter).
    latestInstance().simulateError()
    vi.advanceTimersByTime(999)
    expect(FakeEventSource.instances).toHaveLength(2) // not yet

    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(3) // reconnected at 1s

    client.stop()
  })

  it('does not reconnect before the backoff delay expires', () => {
    const client = new SseClient()
    client.start()

    latestInstance().simulateError()
    vi.advanceTimersByTime(999)
    expect(FakeEventSource.instances).toHaveLength(1) // still waiting

    client.stop()
  })
})

describe('SseClient — connection_lost after 5 failures', () => {
  it('emits connection_lost synthetic event after 5 failed attempts', () => {
    const client = new SseClient()
    client.start()

    const received: SseEvent[] = []
    client.on((e) => received.push(e))

    const delays = [1_000, 2_000, 4_000, 8_000, 30_000]

    for (let i = 0; i < 5; i++) {
      latestInstance().simulateError()
      vi.advanceTimersByTime(delays[i])
    }

    // After 5 failures the 5th reconnect attempt fires but then exhausts.
    // The last simulateError on the 5th connection triggers connection_lost.
    latestInstance().simulateError()

    const lostEvents = received.filter((e) => e.type === 'connection_lost')
    expect(lostEvents).toHaveLength(1)
    expect(lostEvents[0].data).toMatchObject({ attempts: 5 })

    client.stop()
  })

  it('stops creating new EventSources after connection_lost', () => {
    const client = new SseClient()
    client.start()

    const delays = [1_000, 2_000, 4_000, 8_000, 30_000]
    for (let i = 0; i < 5; i++) {
      latestInstance().simulateError()
      vi.advanceTimersByTime(delays[i])
    }
    // Trigger connection_lost.
    latestInstance().simulateError()

    const countAfterLost = FakeEventSource.instances.length

    // Advance all timers — no additional connections should be created.
    vi.runAllTimers()
    expect(FakeEventSource.instances).toHaveLength(countAfterLost)

    client.stop()
  })

  it('stop() prevents connection_lost from firing', () => {
    const client = new SseClient()
    client.start()

    const received: SseEvent[] = []
    client.on((e) => received.push(e))

    latestInstance().simulateError()
    client.stop() // stop before timers fire

    vi.runAllTimers()
    expect(received.filter((e) => e.type === 'connection_lost')).toHaveLength(0)
  })
})

describe('SseClient — all supported event types', () => {
  const types = [
    'capture_created',
    'pipeline_complete',
    'skill_complete',
    'bet_expiring',
    'upload:status',
    'brief_created',
  ] as const

  for (const type of types) {
    it(`delivers ${type} events`, () => {
      const client = new SseClient()
      client.start()

      const received: SseEvent[] = []
      client.on((e) => received.push(e))

      latestInstance().simulateEvent(type, { test: true })
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe(type)

      client.stop()
    })
  }
})
