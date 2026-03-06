import type { Hono } from 'hono'
import type { CaptureService } from '../services/capture.js'

export function registerStatsRoutes(app: Hono, captureService: CaptureService): void {
  app.get('/api/v1/stats', async (c) => {
    const stats = await captureService.getStats()
    return c.json(stats)
  })
}
