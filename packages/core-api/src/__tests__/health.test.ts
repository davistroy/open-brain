import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { errorHandler } from '../middleware/error-handler.js'

// Mock pg and ioredis to avoid needing live services
vi.mock('pg', () => {
  return {
    Pool: vi.fn().mockImplementation(() => ({
      query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

vi.mock('ioredis', () => {
  return {
    Redis: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue('PONG'),
      disconnect: vi.fn(),
    })),
  }
})

// Mock fetch for LiteLLM
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('health endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
  })

  it('returns healthy when all services are up', async () => {
    const { registerHealthRoutes } = await import('../routes/health.js')
    const app = new Hono()
    app.onError(errorHandler())
    registerHealthRoutes(app)

    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('healthy')
    expect(body.services.postgres.status).toBe('healthy')
    expect(body.services.redis.status).toBe('healthy')
    expect(body.services.litellm.status).toBe('healthy')
    expect(body.timestamp).toBeTruthy()
  })

  it('returns degraded when LiteLLM is down', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'))

    const { registerHealthRoutes } = await import('../routes/health.js')
    const app = new Hono()
    registerHealthRoutes(app)

    const res = await app.request('/health')
    expect(res.status).toBe(200) // still 200 (not 503)
    const body = await res.json()
    expect(body.status).toBe('degraded')
    expect(body.services.litellm.status).toBe('degraded')
  })

  it('returns 503 when Postgres is down', async () => {
    const { Pool } = await import('pg')
    vi.mocked(Pool).mockImplementationOnce(() => ({
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
      end: vi.fn().mockResolvedValue(undefined),
    }) as any)

    const { registerHealthRoutes } = await import('../routes/health.js')
    const app = new Hono()
    registerHealthRoutes(app)

    const res = await app.request('/health')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('unhealthy')
    expect(body.services.postgres.status).toBe('unhealthy')
  })
})
