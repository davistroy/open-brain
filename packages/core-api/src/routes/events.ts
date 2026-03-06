// GET /api/v1/events — Server-Sent Events endpoint
// Streams real-time events to the web dashboard.
// Events: capture_created, pipeline_complete, skill_complete, bet_expiring
// Keeps connection alive with a heartbeat every 30s.
// Uses Postgres LISTEN/NOTIFY via pgNotify singleton.

import type { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { pgNotify } from '../lib/pg-notify.js'
import { logger } from '../lib/logger.js'

export function registerEventsRoutes(app: Hono): void {
  app.get('/api/v1/events', (c) => {
    // Set SSE headers
    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no') // disable nginx buffering

    return stream(c, async (s) => {
      let closed = false

      // Send initial connection confirmation
      await s.write(`event: connected\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)

      // Subscribe to Postgres NOTIFY events
      const unsub = pgNotify.subscribe(async (payload) => {
        if (closed) return
        try {
          const data = JSON.stringify(payload.data)
          await s.write(`event: ${payload.channel}\ndata: ${data}\n\n`)
        } catch (err) {
          logger.debug({ err }, 'SSE write error')
        }
      })

      // Heartbeat every 30s to keep connection alive through proxies
      const heartbeat = setInterval(async () => {
        if (closed) {
          clearInterval(heartbeat)
          return
        }
        try {
          await s.write(`: heartbeat ${Date.now()}\n\n`)
        } catch {
          closed = true
          clearInterval(heartbeat)
          unsub()
        }
      }, 30_000)

      // Cleanup when client disconnects
      s.onAbort(() => {
        closed = true
        clearInterval(heartbeat)
        unsub()
        logger.debug('SSE client disconnected')
      })

      // Keep the stream open until the client disconnects
      // hono/streaming holds the response open while the callback is alive
      await new Promise<void>((resolve) => {
        s.onAbort(resolve)
      })

      closed = true
      clearInterval(heartbeat)
      unsub()
    })
  })
}
