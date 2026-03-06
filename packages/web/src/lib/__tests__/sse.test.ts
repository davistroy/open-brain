import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock EventSource before importing the module under test so the class
// constructor sees our mock when SseClient.connect() calls `new EventSource(...)`.
type EventHandler = (event: MessageEvent) => void

class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  onerror: (() => void) | null = null
  private listeners: Map<string, EventHandler[]> = new Map()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: EventHandler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type)!.push(handler)
  }

  removeEventListener(type: string, handler: EventHandler) {
    const handlers = this.listeners.get(type) ?? []
    this.listeners.set(type, handlers.filter((h) => h !== handler))
  }

  close() {
    // mark as closed — nothing else needed
  }

  // Helper used by tests to simulate an incoming SSE event
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    const handlers = this.listeners.get(type) ?? []
    for (const h of handlers) h(event)
  }
}

vi.stubGlobal('EventSource', MockEventSource)

// Import AFTER stubbing so the module closes over the mock
import { sseClient, type SseEvent } from '../sse'

beforeEach(() => {
  MockEventSource.instances = []
  // Always stop the client between tests so state is clean
  sseClient.stop()
})

afterEach(() => {
  sseClient.stop()
})

describe('SseClient', () => {
  it('creates an EventSource when started', () => {
    sseClient.start()
    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0].url).toBe('/api/v1/events')
  })

  it('does not create a second EventSource if already started', () => {
    sseClient.start()
    sseClient.start()
    expect(MockEventSource.instances.length).toBe(1)
  })

  it('delivers events to registered handlers', () => {
    const received: SseEvent[] = []
    sseClient.start()
    const off = sseClient.on((evt) => received.push(evt))

    const es = MockEventSource.instances[0]
    es.emit('capture_created', { id: '123' })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('capture_created')
    expect(received[0].data).toEqual({ id: '123' })

    off()
  })

  it('unsubscribes handler via the returned off function', () => {
    const received: SseEvent[] = []
    sseClient.start()
    const off = sseClient.on((evt) => received.push(evt))
    off()

    const es = MockEventSource.instances[0]
    es.emit('capture_created', { id: '456' })

    expect(received).toHaveLength(0)
  })

  it('stops and clears the EventSource when stop() is called', () => {
    sseClient.start()
    expect(MockEventSource.instances.length).toBe(1)
    sseClient.stop()
    // After stop a new start should create a fresh EventSource
    sseClient.start()
    expect(MockEventSource.instances.length).toBe(2)
  })
})
