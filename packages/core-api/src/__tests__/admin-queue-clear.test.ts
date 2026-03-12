import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// Mock bullmq Queue — must be before importing the admin router
const mockClean = vi.fn().mockResolvedValue(['job-1', 'job-2'])
const mockGetJobCounts = vi.fn().mockResolvedValue({
  active: 0, waiting: 0, completed: 0, failed: 2, delayed: 0,
})

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    clean: mockClean,
    getJobCounts: mockGetJobCounts,
  })),
}))

// Mock @bull-board/* to avoid needing serve-static
vi.mock('@bull-board/api', () => ({
  createBullBoard: vi.fn(),
}))
vi.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: vi.fn(),
}))
vi.mock('@bull-board/hono', () => ({
  HonoAdapter: vi.fn().mockImplementation(() => ({
    setBasePath: vi.fn(),
    registerPlugin: vi.fn().mockReturnValue(new Hono()),
  })),
}))
vi.mock('@hono/node-server/serve-static', () => ({
  serveStatic: vi.fn(),
}))

// Mock ConfigService
const mockConfigService = {
  reload: vi.fn().mockReturnValue([{ file: 'test.yaml', success: true }]),
  get: vi.fn(),
} as any

describe('POST /queues/:name/clear', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockClean.mockResolvedValue(['job-1', 'job-2'])

    const { createAdminRouter } = await import('../routes/admin.js')
    app = new Hono()
    const adminRouter = createAdminRouter({
      configService: mockConfigService,
      redisConnection: { host: 'localhost', port: 6379 },
    })
    app.route('/api/v1/admin', adminRouter)
  })

  it('clears failed jobs from a valid queue with default options', async () => {
    const res = await app.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.queue).toBe('capture-pipeline')
    expect(body.state).toBe('failed')
    expect(body.cleared_count).toBe(2)
    expect(body.cleared_at).toBeTruthy()
    expect(mockClean).toHaveBeenCalledWith(0, 1000, 'failed')
  })

  it('accepts custom state in request body', async () => {
    const res = await app.request('/api/v1/admin/queues/notification/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'completed' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.state).toBe('completed')
    expect(mockClean).toHaveBeenCalledWith(0, 1000, 'completed')
  })

  it('accepts delayed state', async () => {
    const res = await app.request('/api/v1/admin/queues/skill-execution/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'delayed' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.state).toBe('delayed')
    expect(mockClean).toHaveBeenCalledWith(0, 1000, 'delayed')
  })

  it('accepts custom grace_period_ms', async () => {
    const res = await app.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grace_period_ms: 5000 }),
    })
    expect(res.status).toBe(200)
    expect(mockClean).toHaveBeenCalledWith(5000, 1000, 'failed')
  })

  it('returns 404 for unknown queue name', async () => {
    const res = await app.request('/api/v1/admin/queues/nonexistent-queue/clear', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Not found')
    expect(body.message).toContain('nonexistent-queue')
    expect(body.message).toContain('capture-pipeline')
  })

  it('returns 400 for invalid state', async () => {
    const res = await app.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'active' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Bad request')
    expect(body.message).toContain('active')
    expect(body.message).toContain('failed')
  })

  it('returns 400 for negative grace_period_ms', async () => {
    const res = await app.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grace_period_ms: -1 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Bad request')
    expect(body.message).toContain('non-negative')
  })

  it('handles empty body gracefully (uses defaults)', async () => {
    mockClean.mockResolvedValue([])
    const res = await app.request('/api/v1/admin/queues/daily-sweep/clear', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.queue).toBe('daily-sweep')
    expect(body.state).toBe('failed')
    expect(body.cleared_count).toBe(0)
  })

  it('works for all valid queue names', async () => {
    const queueNames = [
      'capture-pipeline',
      'skill-execution',
      'notification',
      'access-stats',
      'daily-sweep',
    ]
    for (const name of queueNames) {
      const res = await app.request(`/api/v1/admin/queues/${name}/clear`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.queue).toBe(name)
    }
  })
})

describe('POST /queues/:name/clear — no Redis', () => {
  it('returns 503 when Redis is not configured', async () => {
    vi.resetModules()
    const { createAdminRouter } = await import('../routes/admin.js')
    const app = new Hono()
    const adminRouter = createAdminRouter({
      configService: mockConfigService,
      // no redisConnection
    })
    app.route('/api/v1/admin', adminRouter)

    const res = await app.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('Service unavailable')
    expect(body.message).toContain('Redis')
  })
})
