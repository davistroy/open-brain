/**
 * SSE client with exponential backoff reconnect.
 *
 * Ports `packages/web/src/lib/sse.ts` but adds reconnect logic mirroring the
 * pg-notify pattern from CLAUDE.md operational rules. The existing /web
 * implementation has NO reconnect — just an onerror console log.
 *
 * Reconnect schedule: 1s → 2s → 4s → 8s → 30s (capped), max 5 attempts.
 * After 5 failures a synthetic `connection_lost` event is emitted so UI can
 * degrade gracefully.
 */

export interface SseEvent {
  type: SseEventType | 'connection_lost'
  data: Record<string, unknown>
}

export type SseEventType =
  | 'capture_created'
  | 'pipeline_complete'
  | 'skill_complete'
  | 'bet_expiring'
  | 'upload:status'
  | 'brief_created'

export type SseEventHandler = (evt: SseEvent) => void

/** Named event types the server emits as distinct SSE event names. */
const EVENT_TYPES: SseEventType[] = [
  'capture_created',
  'pipeline_complete',
  'skill_complete',
  'bet_expiring',
  'upload:status',
  'brief_created',
]

/** Backoff delays in milliseconds (index = attempt number, 0-based). */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 30_000]
const MAX_ATTEMPTS = 5

export class SseClient {
  private readonly url: string
  private es: EventSource | null = null
  private handlers: Set<SseEventHandler> = new Set()
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(url = '/api/v1/events') {
    this.url = url
  }

  start(): void {
    if (this.es || this.stopped) return
    this._connect()
  }

  stop(): void {
    this.stopped = true
    this._clearRetry()
    if (this.es) {
      this.es.close()
      this.es = null
    }
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  on(handler: SseEventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private _connect(): void {
    if (this.stopped) return

    const es = new EventSource(this.url)
    this.es = es

    es.onopen = () => {
      // Successful connection — reset backoff counter.
      this.attempts = 0
    }

    es.onerror = () => {
      // Close the current (broken) connection before scheduling reconnect.
      es.close()
      this.es = null
      this._scheduleReconnect()
    }

    // Register named event listeners.
    for (const eventType of EVENT_TYPES) {
      es.addEventListener(eventType, (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>
          this._emit({ type: eventType, data })
        } catch {
          // Ignore malformed JSON (e.g., heartbeat frames).
        }
      })
    }

    // Generic message fallback.
    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>
        this._emit({ type: 'capture_created', data })
      } catch {
        // Ignore non-JSON messages.
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return

    if (this.attempts >= MAX_ATTEMPTS) {
      // All attempts exhausted — emit synthetic event so UI can degrade.
      this._emit({ type: 'connection_lost', data: { attempts: MAX_ATTEMPTS } })
      return
    }

    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]
    this.attempts++

    this._clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this._connect()
    }, delay)
  }

  private _clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private _emit(evt: SseEvent): void {
    for (const handler of this.handlers) {
      handler(evt)
    }
  }
}

/** Singleton for use across the app (mirroring /web pattern). */
export const sseClient = new SseClient()
