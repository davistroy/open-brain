import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '@open-brain/shared'
import { ContainerHealthSkill } from '../skills/container-health.js'
import type { ContainerEndpoint } from '../skills/container-health.js'

// ============================================================
// Mock helpers
// ============================================================

const TEST_ENDPOINTS: ContainerEndpoint[] = [
  { name: 'core-api', url: 'http://core-api:3000/health' },
  { name: 'workers', url: 'http://workers:3001/health' },
  { name: 'web', url: 'http://web:5173/' },
]

/**
 * Creates a mock fetch that returns healthy for all URLs by default.
 * Pass `unhealthyContainers` to make specific URLs return errors.
 */
function makeMockFetch(unhealthyUrls: Set<string> = new Set()): typeof globalThis.fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    if (unhealthyUrls.has(urlStr)) {
      return new Response('Service Unavailable', { status: 503 })
    }
    return new Response(JSON.stringify({ status: 'healthy' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

/**
 * Creates a mock fetch that throws (simulates network error).
 */
function makeFailingFetch(): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch
}

function makeMockDb(consecutiveUnhealthyRows: { healthy: boolean }[] = []) {
  const executeMock = vi.fn().mockResolvedValue({ rows: consecutiveUnhealthyRows })
  return {
    execute: executeMock,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makePushover(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeSkill(opts: {
  fetchFn?: typeof globalThis.fetch
  pushoverConfigured?: boolean
  consecutiveUnhealthyRows?: { healthy: boolean }[]
  endpoints?: ContainerEndpoint[]
} = {}) {
  const db = makeMockDb(opts.consecutiveUnhealthyRows ?? [])
  const pushover = makePushover(opts.pushoverConfigured ?? true)
  const fetchFn = opts.fetchFn ?? makeMockFetch()

  const skill = new ContainerHealthSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
    fetchFn,
    endpoints: opts.endpoints ?? TEST_ENDPOINTS,
  })

  return { skill, db, pushover, fetchFn }
}

// ============================================================
// Tests
// ============================================================

describe('ContainerHealthSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('all containers healthy', () => {
    it('returns all healthy when all /health checks pass', async () => {
      const { skill } = makeSkill()

      const result = await skill.execute()

      expect(result.healthyCount).toBe(3)
      expect(result.unhealthyCount).toBe(0)
      expect(result.alertsSent).toHaveLength(0)
      expect(result.checks).toHaveLength(3)
      for (const check of result.checks) {
        expect(check.healthy).toBe(true)
        expect(check.response_ms).toBeGreaterThanOrEqual(0)
      }
    })

    it('writes results to container_health table', async () => {
      const { skill, db } = makeSkill()

      await skill.execute()

      // 3 insert calls for container_health + 1 for skills_log
      expect(db.insert).toHaveBeenCalledTimes(4)
    })
  })

  describe('unhealthy containers', () => {
    it('detects container returning 503', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)

      const { skill } = makeSkill({ fetchFn })

      const result = await skill.execute()

      expect(result.healthyCount).toBe(2)
      expect(result.unhealthyCount).toBe(1)

      const unhealthy = result.checks.find(c => c.container_name === 'workers')
      expect(unhealthy?.healthy).toBe(false)
    })

    it('detects container with network error', async () => {
      const fetchFn = makeFailingFetch()

      const { skill } = makeSkill({ fetchFn })

      const result = await skill.execute()

      expect(result.healthyCount).toBe(0)
      expect(result.unhealthyCount).toBe(3)
      for (const check of result.checks) {
        expect(check.healthy).toBe(false)
        expect(check.error).toContain('ECONNREFUSED')
      }
    })
  })

  describe('consecutive failure alerting', () => {
    it('sends alert after 3 consecutive failures', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)
      // 3 consecutive unhealthy rows (including the current one just written)
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: false },
      ]

      const { skill, pushover } = makeSkill({
        fetchFn,
        consecutiveUnhealthyRows: consecutiveRows,
      })

      const result = await skill.execute({ consecutiveFailureThreshold: 3 })

      expect(result.alertsSent).toContain('workers')
      expect(pushover.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Open Brain: workers unhealthy',
          priority: 1,
        }),
      )
    })

    it('does not alert when consecutive count is below threshold', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)
      // Only 2 consecutive failures — below threshold of 3
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: true },
      ]

      const { skill, pushover } = makeSkill({
        fetchFn,
        consecutiveUnhealthyRows: consecutiveRows,
      })

      const result = await skill.execute({ consecutiveFailureThreshold: 3 })

      expect(result.alertsSent).toHaveLength(0)
      expect(pushover.send).not.toHaveBeenCalled()
    })

    it('does not alert when Pushover is not configured', async () => {
      const unhealthyUrls = new Set(['http://workers:3001/health'])
      const fetchFn = makeMockFetch(unhealthyUrls)
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: false },
      ]

      const { skill, pushover } = makeSkill({
        fetchFn,
        pushoverConfigured: false,
        consecutiveUnhealthyRows: consecutiveRows,
      })

      const result = await skill.execute({ consecutiveFailureThreshold: 3 })

      expect(result.alertsSent).toHaveLength(0)
      expect(pushover.send).not.toHaveBeenCalled()
    })
  })

  describe('custom endpoints', () => {
    it('checks only the configured endpoints', async () => {
      const customEndpoints: ContainerEndpoint[] = [
        { name: 'test-svc', url: 'http://test:8080/health' },
      ]
      const { skill } = makeSkill({ endpoints: customEndpoints })

      const result = await skill.execute()

      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].container_name).toBe('test-svc')
    })
  })

  describe('getConsecutiveFailureCount', () => {
    it('counts consecutive unhealthy rows from most recent', async () => {
      const consecutiveRows = [
        { healthy: false },
        { healthy: false },
        { healthy: true },
        { healthy: false },
      ]
      const { skill } = makeSkill({ consecutiveUnhealthyRows: consecutiveRows })

      const count = await skill.getConsecutiveFailureCount('test')

      // Stops at first healthy row — count is 2
      expect(count).toBe(2)
    })

    it('returns 0 when most recent check is healthy', async () => {
      const consecutiveRows = [
        { healthy: true },
        { healthy: false },
        { healthy: false },
      ]
      const { skill } = makeSkill({ consecutiveUnhealthyRows: consecutiveRows })

      const count = await skill.getConsecutiveFailureCount('test')

      expect(count).toBe(0)
    })
  })

  describe('skills_log', () => {
    it('writes summary to skills_log', async () => {
      const { skill, db } = makeSkill()

      await skill.execute()

      // Last insert call should be skills_log
      const insertCalls = db.insert.mock.calls
      expect(insertCalls.length).toBeGreaterThan(0)
    })
  })
})
