/**
 * Activity feed routes.
 *
 * GET /api/v1/activity/feed          — paginated, filterable activity feed
 * GET /api/v1/activity/feed/stream   — SSE stream of new activity entries
 */

import type { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { logger } from '@open-brain/shared'
import type { ActivityFeedService } from '../services/activity-feed.js'
import { pgNotify } from '../lib/pg-notify.js'

export function registerActivityRoutes(
  app: Hono,
  activityFeedService: ActivityFeedService,
): void {
  // ---- Paginated feed endpoint ----
  app.get('/api/v1/activity/feed', async (c) => {
    const type = c.req.query('type')
    const view = c.req.query('view')
    const since = c.req.query('since')
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
    const offset = Number(c.req.query('offset') ?? 0)

    const filter: { type?: string; view?: string; since?: Date } = {}
    if (type) filter.type = type
    if (view) filter.view = view
    if (since) {
      const sinceDate = new Date(since)
      if (!isNaN(sinceDate.getTime())) {
        filter.since = sinceDate
      }
    }

    const page = await activityFeedService.list(filter, limit, offset)
    return c.json({
      items: page.items,
      total: page.total,
      limit,
      offset,
    })
  })

  // ---- SSE stream endpoint ----
  app.get('/api/v1/activity/feed/stream', (c) => {
    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no') // disable nginx buffering

    return stream(c, async (s) => {
      let closed = false

      // Send initial connection confirmation
      await s.write(`event: connected\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)

      // Subscribe to activity_feed pg-notify channel
      const unsub = pgNotify.subscribe(async (payload) => {
        if (closed) return
        if (payload.channel !== 'activity_feed') return
        try {
          const data = JSON.stringify(payload.data)
          await s.write(`event: activity\ndata: ${data}\n\n`)
        } catch (err) {
          logger.debug({ err }, 'Activity SSE write error')
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
        logger.debug('Activity SSE client disconnected')
      })

      // Keep the stream open until the client disconnects
      await new Promise<void>((resolve) => {
        s.onAbort(resolve)
      })

      closed = true
      clearInterval(heartbeat)
      unsub()
    })
  })
}
