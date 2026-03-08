import pg from 'pg'
import { logger } from './logger.js'

export interface NotifyPayload {
  channel: string
  data: Record<string, unknown>
}

type Subscriber = (payload: NotifyPayload) => void | Promise<void>

/**
 * Singleton for Postgres LISTEN/NOTIFY support.
 * Used for real-time event streaming via SSE.
 */
class PgNotify {
  private client: pg.Client | null = null
  private subscribers: Set<Subscriber> = new Set()
  private channels = ['capture_created', 'pipeline_complete', 'skill_complete', 'bet_expiring']

  async start(postgresUrl: string): Promise<void> {
    if (this.client) return

    this.client = new pg.Client({ connectionString: postgresUrl })
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
    })

    for (const channel of this.channels) {
      await this.client.query(`LISTEN ${channel}`)
    }
    logger.info({ channels: this.channels }, 'pgNotify listening')
  }

  async stop(): Promise<void> {
    if (!this.client) return
    await this.client.end()
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
