import pg from 'pg'
import { logger } from '@open-brain/shared'

export interface NotifyPayload {
  channel: string
  data: Record<string, unknown>
}

type Subscriber = (payload: NotifyPayload) => void | Promise<void>

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * Singleton for Postgres LISTEN/NOTIFY support.
 * Used for real-time event streaming via SSE.
 *
 * Automatically reconnects with exponential backoff when the Postgres
 * connection drops, re-subscribing to all LISTEN channels.
 */
class PgNotify {
  private client: pg.Client | null = null
  private subscribers: Set<Subscriber> = new Set()
  private channels: Set<string> = new Set([
    'capture_created',
    'pipeline_complete',
    'skill_complete',
    'bet_expiring',
    'activity_feed',
    // CS3.6 — upload lifecycle events emitted by workers/ingest-process.ts
    // and core-api routes/ingest.ts. events.ts re-emits as SSE event
    // name `upload:status` per the plan contract.
    'upload_status',
  ])
  private postgresUrl: string | null = null
  private reconnecting = false
  private stopped = false

  async start(postgresUrl: string): Promise<void> {
    if (this.client) return

    this.postgresUrl = postgresUrl
    this.stopped = false
    await this.connect()
  }

  private async connect(): Promise<void> {
    if (!this.postgresUrl) throw new Error('pgNotify: no postgresUrl configured')

    this.client = new pg.Client({ connectionString: this.postgresUrl })
    await this.client.connect()

    this.client.on('notification', (msg) => {
      if (!msg.payload) return
      try {
        const data = JSON.parse(msg.payload)
        const payload: NotifyPayload = { channel: msg.channel, data }
        for (const sub of this.subscribers) {
          Promise.resolve(sub(payload)).catch((err) => {
            logger.warn({ err }, 'pgNotify subscriber error')
          })
        }
      } catch (err) {
        logger.warn({ err, raw: msg.payload }, 'pgNotify parse error')
      }
    })

    this.client.on('error', (err) => {
      logger.error({ err }, 'pgNotify connection error')
      this.client = null
      if (!this.stopped) {
        this.scheduleReconnect()
      }
    })

    for (const channel of this.channels) {
      await this.client.query(`LISTEN ${channel}`)
    }
    logger.info({ channels: [...this.channels] }, 'pgNotify listening')
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.stopped) return
    this.reconnecting = true
    this.attemptReconnect(0).catch(() => {
      // exhaustion already logged inside attemptReconnect
    })
  }

  private async attemptReconnect(attempt: number): Promise<void> {
    if (this.stopped) {
      this.reconnecting = false
      return
    }

    if (attempt >= RECONNECT_DELAYS.length) {
      logger.error(
        { attempts: attempt },
        'pgNotify reconnection exhausted — giving up. Restart the container to recover.',
      )
      this.reconnecting = false
      return
    }

    const delay = RECONNECT_DELAYS[attempt]
    logger.info({ attempt: attempt + 1, delayMs: delay }, 'pgNotify scheduling reconnection attempt')

    await new Promise((resolve) => setTimeout(resolve, delay))

    if (this.stopped) {
      this.reconnecting = false
      return
    }

    try {
      await this.connect()
      logger.info({ attempt: attempt + 1 }, 'pgNotify reconnected successfully')
      this.reconnecting = false
    } catch (err) {
      logger.warn({ err, attempt: attempt + 1 }, 'pgNotify reconnection attempt failed')
      this.client = null
      await this.attemptReconnect(attempt + 1)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.reconnecting = false
    if (!this.client) return
    try {
      await this.client.end()
    } catch {
      // already dead, ignore
    }
    this.client = null
    this.subscribers.clear()
    logger.info('pgNotify stopped')
  }

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  async notify(channel: string, data: Record<string, unknown>): Promise<void> {
    if (!this.client) return
    const payload = JSON.stringify(data)
    await this.client.query(`SELECT pg_notify($1, $2)`, [channel, payload])
  }
}

export const pgNotify = new PgNotify()
