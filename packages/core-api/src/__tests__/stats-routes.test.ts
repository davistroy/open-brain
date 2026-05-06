/**
 * Phase 4.4 — stats route unit tests.
 *
 * Covers `packages/core-api/src/routes/stats.ts`:
 *   GET /api/v1/stats — returns CaptureStats aggregation object
 *
 * DI strategy:
 *   - `makeTestApp` + `registerStatsRoutes` from helpers.ts
 *   - `makeMockService<CaptureService>(['getStats'])` from helpers.ts
 *   - No DB wiring needed — route delegates entirely to captureService.getStats()
 *
 * DI gap surfaced: stats route takes CaptureService directly (not injected via
 * a factory), so getStats() is the single mock surface. No additional DI gaps.
 */
import { describe, it, expect } from 'vitest'
import type { CaptureService } from '../services/capture.js'
import { registerStatsRoutes } from '../routes/stats.js'
import { makeTestApp, makeMockService, testJson, DEFAULT_HEADERS } from './helpers.js'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_STATS = {
  total_captures: 42,
  by_source: {
    api: 20,
    slack: 10,
    voice: 8,
    email: 4,
  },
  by_type: {
    idea: 15,
    observation: 12,
    task: 10,
    decision: 5,
  },
  by_view: {
    technical: 18,
    work_internal: 14,
    personal: 10,
  },
  pipeline_health: {
    pending: 2,
    processing: 1,
    complete: 38,
    failed: 1,
  },
  total_entities: 87,
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp(statsResult: Record<string, unknown> = SAMPLE_STATS) {
  const captureService = makeMockService<CaptureService>(['getStats'])
  captureService.getStats.mockResolvedValue(statsResult)

  const app = makeTestApp((a) => {
    registerStatsRoutes(a, captureService as unknown as CaptureService)
  })

  return { app, captureService }
}

// ---------------------------------------------------------------------------
// GET /api/v1/stats
// ---------------------------------------------------------------------------

describe('GET /api/v1/stats', () => {
  it('returns 200 with the aggregation contract shape', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/stats')
    const b = body as typeof SAMPLE_STATS

    expect(status).toBe(200)
    expect(b.total_captures).toBe(42)
    expect(b.by_source).toMatchObject({ api: 20, slack: 10 })
    expect(b.by_type).toMatchObject({ idea: 15, task: 10 })
    expect(b.pipeline_health).toMatchObject({ pending: 2, complete: 38 })
    expect(b.total_entities).toBe(87)
  })

  it('calls captureService.getStats() exactly once', async () => {
    const { app, captureService } = buildApp()

    await testJson(app, '/api/v1/stats')

    expect(captureService.getStats).toHaveBeenCalledOnce()
  })

  it('by_view is present in the response', async () => {
    const { app } = buildApp()

    const { body } = await testJson(app, '/api/v1/stats')
    const b = body as typeof SAMPLE_STATS

    expect(b.by_view).toBeDefined()
    expect(b.by_view.technical).toBe(18)
  })

  it('returns all-zero counters when brain is empty', async () => {
    const emptyStats = {
      total_captures: 0,
      by_source: {},
      by_type: {},
      by_view: {},
      pipeline_health: { pending: 0, processing: 0, complete: 0, failed: 0 },
      total_entities: 0,
    }
    const { app } = buildApp(emptyStats)

    const { status, body } = await testJson(app, '/api/v1/stats')
    const b = body as typeof emptyStats

    expect(status).toBe(200)
    expect(b.total_captures).toBe(0)
    expect(b.total_entities).toBe(0)
    expect(b.pipeline_health.failed).toBe(0)
  })

  it('forwards service errors as 500', async () => {
    const captureService = makeMockService<CaptureService>(['getStats'])
    captureService.getStats.mockRejectedValue(new Error('DB connection lost'))

    const app = makeTestApp((a) => {
      registerStatsRoutes(a, captureService as unknown as CaptureService)
    })

    const { status } = await testJson(app, '/api/v1/stats', { headers: DEFAULT_HEADERS })

    expect(status).toBe(500)
  })

  it('returns Content-Type application/json', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/v1/stats')

    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })
})
