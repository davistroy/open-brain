import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock BullMQ Queue — must be hoisted before service import
// ---------------------------------------------------------------------------

const mockGetJobCounts = vi.fn()
const mockQueueClose = vi.fn().mockResolvedValue(undefined)

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    getJobCounts: mockGetJobCounts,
    close: mockQueueClose,
  })),
}))

// ---------------------------------------------------------------------------
// Mock ioredis — Redis INFO command
// ---------------------------------------------------------------------------

const mockRedisInfo = vi.fn()
const mockRedisConnect = vi.fn().mockResolvedValue(undefined)
const mockRedisDisconnect = vi.fn()

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    connect: mockRedisConnect,
    info: mockRedisInfo,
    disconnect: mockRedisDisconnect,
  })),
}))

// ---------------------------------------------------------------------------
// Mock pg (required by health.ts which registers /health globally)
// ---------------------------------------------------------------------------

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

import {
  SystemHealthService,
  MONITORED_QUEUES,
  QUEUE_DEPTH_WARNING,
  QUEUE_DEPTH_CRITICAL,
  SPEND_WARNING,
  SPEND_CRITICAL,
} from '../services/system-health.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(spendRow = { total_usd: '0', non_claude_usd: '0' }, skillRows: unknown[] = []) {
  let callCount = 0
  return {
    execute: vi.fn().mockImplementation(() => {
      callCount++
      // First call = monthly spend, second call = skill last runs
      if (callCount === 1) return { rows: [spendRow] }
      return { rows: skillRows }
    }),
  }
}

const DEFAULT_REDIS_CONNECTION = { host: 'localhost', port: 6379 }
const DEFAULT_REDIS_URL = 'redis://localhost:6379'

function defaultQueueCounts() {
  return { waiting: 0, active: 0, failed: 0, delayed: 0 }
}

function redisInfoString(used: number, max: number) {
  return `# Memory\r\nused_memory:${used}\r\nused_memory_human:1M\r\nmaxmemory:${max}\r\nmaxmemory_human:100M\r\n`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SystemHealthService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetJobCounts.mockResolvedValue(defaultQueueCounts())
    mockRedisInfo.mockResolvedValue(redisInfoString(10_000_000, 100_000_000))
  })

  describe('snapshot()', () => {
    it('returns healthy when all systems are nominal', async () => {
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const result = await service.snapshot()

      expect(result.status).toBe('healthy')
      expect(result.queues).toHaveLength(MONITORED_QUEUES.length)
      expect(result.redis_memory.status).toBe('healthy')
      expect(result.monthly_spend.status).toBe('healthy')
      expect(result.timestamp).toBeTruthy()
      expect(result.uptime_s).toBeGreaterThanOrEqual(0)
    })

    it('returns degraded when queue depth exceeds warning threshold', async () => {
      mockGetJobCounts.mockResolvedValue({ waiting: QUEUE_DEPTH_WARNING + 10, active: 0, failed: 0, delayed: 0 })
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const result = await service.snapshot()

      expect(result.status).toBe('degraded')
      result.queues.forEach(q => expect(q.status).toBe('degraded'))
    })

    it('returns unhealthy when queue depth exceeds critical threshold', async () => {
      mockGetJobCounts.mockResolvedValue({ waiting: QUEUE_DEPTH_CRITICAL + 10, active: 0, failed: 0, delayed: 0 })
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const result = await service.snapshot()

      expect(result.status).toBe('unhealthy')
      result.queues.forEach(q => expect(q.status).toBe('unhealthy'))
    })

    it('counts active + waiting for queue depth threshold', async () => {
      // 30 waiting + 25 active = 55 total > 50 warning
      mockGetJobCounts.mockResolvedValue({ waiting: 30, active: 25, failed: 0, delayed: 0 })
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const result = await service.snapshot()

      result.queues.forEach(q => {
        expect(q.waiting).toBe(30)
        expect(q.active).toBe(25)
        expect(q.status).toBe('degraded')
      })
    })
  })

  describe('getQueueStats()', () => {
    it('monitors all expected queues', async () => {
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const stats = await service.getQueueStats()

      const names = stats.map(q => q.name)
      expect(names).toContain('capture-pipeline')
      expect(names).toContain('embed-capture')
      expect(names).toContain('skill-execution')
      expect(names).toContain('daily-sweep')
      expect(names).toContain('ingest-root')
    })

    it('returns degraded for queues that fail to connect', async () => {
      mockGetJobCounts.mockRejectedValue(new Error('ECONNREFUSED'))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const stats = await service.getQueueStats()

      stats.forEach(q => {
        expect(q.status).toBe('degraded')
        expect(q.waiting).toBe(0)
        expect(q.active).toBe(0)
      })
    })

    it('closes queue instances after use', async () => {
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      await service.getQueueStats()

      expect(mockQueueClose).toHaveBeenCalledTimes(MONITORED_QUEUES.length)
    })
  })

  describe('getRedisMemory()', () => {
    it('parses Redis INFO memory correctly', async () => {
      mockRedisInfo.mockResolvedValue(redisInfoString(50_000_000, 100_000_000))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const mem = await service.getRedisMemory()

      expect(mem.used_bytes).toBe(50_000_000)
      expect(mem.max_bytes).toBe(100_000_000)
      expect(mem.used_pct).toBe(0.5)
      expect(mem.status).toBe('healthy')
    })

    it('returns warning when memory exceeds 80%', async () => {
      mockRedisInfo.mockResolvedValue(redisInfoString(85_000_000, 100_000_000))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const mem = await service.getRedisMemory()

      expect(mem.used_pct).toBe(0.85)
      expect(mem.status).toBe('degraded')
    })

    it('returns critical when memory exceeds 95%', async () => {
      mockRedisInfo.mockResolvedValue(redisInfoString(96_000_000, 100_000_000))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const mem = await service.getRedisMemory()

      expect(mem.used_pct).toBe(0.96)
      expect(mem.status).toBe('unhealthy')
    })

    it('returns healthy when maxmemory is 0 (no limit)', async () => {
      mockRedisInfo.mockResolvedValue(redisInfoString(50_000_000, 0))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const mem = await service.getRedisMemory()

      expect(mem.max_bytes).toBe(0)
      expect(mem.used_pct).toBe(0)
      expect(mem.status).toBe('healthy')
    })

    it('returns degraded when Redis connection fails', async () => {
      mockRedisConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const mem = await service.getRedisMemory()

      expect(mem.status).toBe('degraded')
      expect(mem.used_bytes).toBe(0)
    })
  })

  describe('getMonthlySpend()', () => {
    it('returns healthy when spend is within budget', async () => {
      const db = makeMockDb({ total_usd: '3.50', non_claude_usd: '3.50' })
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const spend = await service.getMonthlySpend()

      expect(spend.total_usd).toBe(3.5)
      expect(spend.non_claude_usd).toBe(3.5)
      expect(spend.status).toBe('healthy')
      expect(spend.month).toMatch(/^\d{4}-\d{2}$/)
    })

    it('returns warning when non-Claude spend exceeds $7', async () => {
      const db = makeMockDb({ total_usd: '12.00', non_claude_usd: '8.50' })
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const spend = await service.getMonthlySpend()

      expect(spend.non_claude_usd).toBe(8.5)
      expect(spend.status).toBe('degraded')
    })

    it('returns critical when non-Claude spend exceeds $10', async () => {
      const db = makeMockDb({ total_usd: '15.00', non_claude_usd: '11.00' })
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const spend = await service.getMonthlySpend()

      expect(spend.non_claude_usd).toBe(11)
      expect(spend.status).toBe('unhealthy')
    })

    it('returns degraded when database query fails', async () => {
      const db = { execute: vi.fn().mockRejectedValue(new Error('connection error')) }
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const spend = await service.getMonthlySpend()

      expect(spend.status).toBe('degraded')
      expect(spend.total_usd).toBe(0)
    })
  })

  describe('getSkillLastRuns()', () => {
    it('returns last run per skill', async () => {
      const skillRows = [
        { skill_name: 'daily-sweep-skill', last_run_at: '2026-04-10T20:00:00Z', duration_ms: 5000, output_summary: '3 items' },
        { skill_name: 'pipeline-health', last_run_at: '2026-04-10T18:00:00Z', duration_ms: 2000, output_summary: 'all clear' },
      ]
      // Build a db mock where second execute call returns skill rows
      let callCount = 0
      const db = {
        execute: vi.fn().mockImplementation(() => {
          callCount++
          if (callCount === 1) return { rows: skillRows }
          return { rows: [] }
        }),
      }
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const runs = await service.getSkillLastRuns()

      expect(runs).toHaveLength(2)
      expect(runs[0].skill_name).toBe('daily-sweep-skill')
    })

    it('returns empty array when database fails', async () => {
      const db = { execute: vi.fn().mockRejectedValue(new Error('connection error')) }
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const runs = await service.getSkillLastRuns()

      expect(runs).toEqual([])
    })
  })

  describe('overall status derivation', () => {
    it('unhealthy overrides everything', async () => {
      // Redis critical + queue normal → unhealthy
      mockRedisInfo.mockResolvedValue(redisInfoString(96_000_000, 100_000_000))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const result = await service.snapshot()

      expect(result.status).toBe('unhealthy')
    })

    it('degraded when no component is unhealthy but some are degraded', async () => {
      mockRedisInfo.mockResolvedValue(redisInfoString(85_000_000, 100_000_000))
      const db = makeMockDb()
      const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)

      const result = await service.snapshot()

      expect(result.status).toBe('degraded')
    })
  })
})

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------

describe('system-health routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetJobCounts.mockResolvedValue(defaultQueueCounts())
    mockRedisInfo.mockResolvedValue(redisInfoString(10_000_000, 100_000_000))
  })

  it('GET /api/v1/system/health returns snapshot JSON', async () => {
    const { createApp } = await import('../app.js')
    const db = makeMockDb()
    const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)
    const app = createApp({ systemHealthService: service })

    const res = await app.request('/api/v1/system/health')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('healthy')
    expect(body.queues).toBeInstanceOf(Array)
    expect(body.redis_memory).toBeDefined()
    expect(body.monthly_spend).toBeDefined()
    expect(body.skill_last_runs).toBeDefined()
  }, 15_000)

  it('GET /api/v1/system/health returns 503 when unhealthy', async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: QUEUE_DEPTH_CRITICAL + 50, active: 0, failed: 0, delayed: 0 })
    const { createApp } = await import('../app.js')
    const db = makeMockDb()
    const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)
    const app = createApp({ systemHealthService: service })

    const res = await app.request('/api/v1/system/health')

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('unhealthy')
  }, 15_000)

  it('GET /api/v1/system/health/stream returns SSE content-type', async () => {
    const { createApp } = await import('../app.js')
    const db = makeMockDb()
    const service = new SystemHealthService(db as any, DEFAULT_REDIS_CONNECTION, DEFAULT_REDIS_URL)
    const app = createApp({ systemHealthService: service })

    const res = await app.request('/api/v1/system/health/stream')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
  }, 15_000)
})
