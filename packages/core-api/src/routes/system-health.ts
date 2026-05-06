/**
 * System Health routes — comprehensive operational metrics.
 *
 * GET /api/v1/system/health         — JSON snapshot of all health metrics
 * GET /api/v1/system/health/stream  — SSE stream updating every 10 seconds
 *
 * Extends the existing /health liveness check with operational data:
 * queue depths, Redis memory, LLM spend, skill run history.
 */

import type { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { logger } from '@open-brain/shared'
import type { SystemHealthService } from '../services/system-health.js'

const SSE_INTERVAL_MS = 10_000

export function registerSystemHealthRoutes(
  app: Hono,
  service: SystemHealthService,
): void {
  // ---- Snapshot endpoint ----
  app.get('/api/v1/system/health', async (c) => {
    const snapshot = await service.snapshot()
    const httpStatus = snapshot.status === 'unhealthy' ? 503 : 200
    return c.json(snapshot, httpStatus)
  })

  // ---- Infrastructure endpoint (container health, backups, cost) ----
  app.get('/api/v1/system/infrastructure', async (c) => {
    const data = await service.getInfrastructureData()
    return c.json(data)
  })

  // ---- Pipeline flows endpoint ----
  app.get('/api/v1/system/flows', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const flows = await service.getPipelineFlows(Math.min(limit, 100))
    return c.json({ flows })
  })

  // ---- SSE stream endpoint ----
  app.get('/api/v1/system/health/stream', (c) => {
    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no') // disable nginx buffering

    return stream(c, async (s) => {
      let closed = false

      // Send initial snapshot immediately
      try {
        const initial = await service.snapshot()
        await s.write(`event: system_health\ndata: ${JSON.stringify(initial)}\n\n`)
      } catch (err) {
        logger.warn({ err }, 'Failed to send initial system health snapshot')
      }

      // Poll every 10 seconds
      const interval = setInterval(async () => {
        if (closed) {
          clearInterval(interval)
          return
        }
        try {
          const snapshot = await service.snapshot()
          await s.write(`event: system_health\ndata: ${JSON.stringify(snapshot)}\n\n`)
        } catch (err) {
          if (!closed) {
            logger.debug({ err }, 'System health SSE write error')
          }
        }
      }, SSE_INTERVAL_MS)

      // Heartbeat every 30 seconds to keep connection alive through proxies
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
          clearInterval(interval)
        }
      }, 30_000)

      // Cleanup when client disconnects
      /* v8 ignore next 5 */
      s.onAbort(() => {
        closed = true
        clearInterval(interval)
        clearInterval(heartbeat)
        logger.debug('System health SSE client disconnected')
      })

      // Keep the stream open until the client disconnects
      await new Promise<void>((resolve) => {
        s.onAbort(resolve)
      })

      /* v8 ignore next 3 */
      closed = true
      clearInterval(interval)
      clearInterval(heartbeat)
    })
  })
}
