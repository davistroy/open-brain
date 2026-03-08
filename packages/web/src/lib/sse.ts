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

/**
 * React hook for SSE connection (to be used with useState/useEffect)
 * Usage:
 *   const [events, setEvents] = useState<SSEEvent[]>([])
 *   useEffect(() => {
 *     return createSSEConnection((evt) => setEvents(prev => [...prev, evt]))
 *   }, [])
 */
