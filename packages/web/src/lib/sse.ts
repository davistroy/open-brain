/**
 * Server-Sent Events client for real-time updates
 */

export interface SSEEvent {
  type: string
  data: Record<string, unknown>
}

export type SSEEventHandler = (event: SSEEvent) => void

/**
 * Create an SSE connection to the Core API events endpoint
 */
export function createSSEConnection(
  onEvent: SSEEventHandler,
  onError?: (error: Error) => void,
): () => void {
  const eventSource = new EventSource('/api/v1/events')

  eventSource.onopen = () => {
    console.log('[SSE] Connected')
  }

  eventSource.onerror = (evt) => {
    console.error('[SSE] Error:', evt)
    if (onError) {
      onError(new Error('SSE connection error'))
    }
  }

  // Handle named event types
  const eventTypes = ['capture_created', 'pipeline_complete', 'skill_complete', 'bet_expiring']

  for (const eventType of eventTypes) {
    eventSource.addEventListener(eventType, (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        onEvent({ type: eventType, data })
      } catch (err) {
        console.error('[SSE] Parse error:', err)
      }
    })
  }

  // Handle generic message events
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      onEvent({ type: 'message', data })
    } catch {
      // Ignore non-JSON messages (like heartbeats)
    }
  }

  // Return cleanup function
  return () => {
    eventSource.close()
    console.log('[SSE] Disconnected')
  }
}

// Re-export for tests
export type SseEvent = SSEEvent

/**
 * Singleton SSE client with start/stop/on semantics
 */
class SseClient {
  private es: EventSource | null = null
  private handlers: Set<SSEEventHandler> = new Set()

  start() {
    if (this.es) return
    this.es = new EventSource('/api/v1/events')
    const eventTypes = ['capture_created', 'pipeline_complete', 'skill_complete', 'bet_expiring']
    for (const eventType of eventTypes) {
      this.es.addEventListener(eventType, (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data)
          for (const handler of this.handlers) handler({ type: eventType, data })
        } catch { /* ignore parse errors */ }
      })
    }
  }

  stop() {
    if (this.es) {
      this.es.close()
      this.es = null
    }
  }

  on(handler: SSEEventHandler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }
}

export const sseClient = new SseClient()

/**
 * React hook for SSE connection (to be used with useState/useEffect)
 * Usage:
 *   const [events, setEvents] = useState<SSEEvent[]>([])
 *   useEffect(() => {
 *     return createSSEConnection((evt) => setEvents(prev => [...prev, evt]))
 *   }, [])
 */
