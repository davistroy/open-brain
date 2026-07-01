import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

// Mock ioredis to avoid real Redis connections (banner feature)
vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
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

// ── SEC-04 — origin guard ────────────────────────────────────────────────────
//
// /queues/:name/clear must be protected by the same origin allowlist as
// /admin/reset-data (arch-review v3 finding SEC-04).
//
// checkOrigin() bypasses the allowlist when NODE_ENV==='test' (fail-closed
// production default). We test origin guarding by temporarily flipping to
// production mode and rebuilding the app after each env change.
describe('POST /queues/:name/clear — SEC-04 origin guard', () => {
  const savedNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.clearAllMocks()
    mockClean.mockResolvedValue(['job-1', 'job-2'])
  })

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv
  })

  async function buildQueueApp(mockAdminService?: unknown) {
    // vi.resetModules() ensures the re-imported admin.ts picks up the current env var
    vi.resetModules()
    const { createAdminRouter } = await import('../routes/admin.js')
    const a = new Hono()
    const opts: Parameters<typeof createAdminRouter>[0] = {
      configService: mockConfigService,
      redisConnection: { host: 'localhost', port: 6379 },
    }
    if (mockAdminService) {
      opts.adminService = mockAdminService as import('../services/admin.service.js').AdminService
    }
    a.route('/api/v1/admin', createAdminRouter(opts))
    return a
  }

  it('blocks non-allowlisted origin in production (403, queue not cleared, audit row written)', async () => {
    process.env.NODE_ENV = 'production'
    const mockWriteAuditRow = vi.fn().mockResolvedValue('audit-blocked-id')
    const a = await buildQueueApp({ writeAuditRow: mockWriteAuditRow })

    const res = await a.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example.com' },
      body: JSON.stringify({ state: 'failed' }),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden')
    // Queue must NOT be cleared
    expect(mockClean).not.toHaveBeenCalled()
    // Audit row must be written even when blocked
    expect(mockWriteAuditRow).toHaveBeenCalledOnce()
    expect(mockWriteAuditRow).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'queue_clear_blocked',
        outcome: 'blocked',
        error_detail: 'origin_check_failed',
      }),
    )
  })

  it('blocks request with no origin header in production (403, queue not cleared)', async () => {
    process.env.NODE_ENV = 'production'
    const mockWriteAuditRow = vi.fn().mockResolvedValue('audit-blocked-id')
    const a = await buildQueueApp({ writeAuditRow: mockWriteAuditRow })

    const res = await a.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
      // no Origin or Referer header
    })

    expect(res.status).toBe(403)
    expect(mockClean).not.toHaveBeenCalled()
    expect(mockWriteAuditRow).toHaveBeenCalledOnce()
    expect(mockWriteAuditRow).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'queue_clear_blocked', outcome: 'blocked' }),
    )
  })

  it('allows brain.troy-davis.com in production (200, cleared, audit row queue_clear_executed)', async () => {
    process.env.NODE_ENV = 'production'
    mockClean.mockResolvedValue(['job-a', 'job-b'])
    const mockWriteAuditRow = vi.fn().mockResolvedValue('audit-exec-id')
    const a = await buildQueueApp({ writeAuditRow: mockWriteAuditRow })

    const res = await a.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://brain.troy-davis.com' },
      body: JSON.stringify({ state: 'failed' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cleared_count).toBe(2)
    expect(mockClean).toHaveBeenCalledOnce()
    // Audit row written on successful clear
    expect(mockWriteAuditRow).toHaveBeenCalledOnce()
    expect(mockWriteAuditRow).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'queue_clear_executed',
        outcome: 'success',
      }),
    )
  })

  it('returns 403 BEFORE clearing even for a valid queue name + invalid origin', async () => {
    process.env.NODE_ENV = 'production'
    const a = await buildQueueApp()

    // Use a queue name that exists but with an evil origin — 403, not 200
    const res = await a.request('/api/v1/admin/queues/skill-execution/clear', {
      method: 'POST',
      headers: { 'Origin': 'https://attacker.net' },
    })

    expect(res.status).toBe(403)
    expect(mockClean).not.toHaveBeenCalled()
  })

  it('skips audit row silently when adminService is absent but still returns 403', async () => {
    process.env.NODE_ENV = 'production'
    // No adminService injected — should still block, just no audit row
    const a = await buildQueueApp() // no adminService

    const res = await a.request('/api/v1/admin/queues/capture-pipeline/clear', {
      method: 'POST',
      headers: { 'Origin': 'https://evil.example.com' },
    })

    expect(res.status).toBe(403)
    expect(mockClean).not.toHaveBeenCalled()
  })
})
