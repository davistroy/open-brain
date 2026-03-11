import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { RateLimiter, rateLimit, RATE_LIMIT_TIERS } from '../middleware/rate-limit.js'

describe('RateLimiter', () => {
  let limiter: RateLimiter

  afterEach(() => {
    limiter?.dispose()
  })

  it('allows requests under the limit', () => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 })
    const r1 = limiter.check('client-a')
    expect(r1.allowed).toBe(true)
    expect(r1.remaining).toBe(2)

    const r2 = limiter.check('client-a')
    expect(r2.allowed).toBe(true)
    expect(r2.remaining).toBe(1)

    const r3 = limiter.check('client-a')
    expect(r3.allowed).toBe(true)
    expect(r3.remaining).toBe(0)
  })

  it('rejects requests over the limit', () => {
    limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 })
    limiter.check('client-a')
    limiter.check('client-a')

    const r3 = limiter.check('client-a')
    expect(r3.allowed).toBe(false)
    expect(r3.remaining).toBe(0)
    expect(r3.retryAfterMs).toBeGreaterThan(0)
  })

  it('tracks clients independently', () => {
    limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 })
    const rA = limiter.check('client-a')
    expect(rA.allowed).toBe(true)

    // client-b has its own window
    const rB = limiter.check('client-b')
    expect(rB.allowed).toBe(true)

    // client-a is now over limit
    const rA2 = limiter.check('client-a')
    expect(rA2.allowed).toBe(false)
  })

  it('resets after the window expires', () => {
    vi.useFakeTimers()
    try {
      limiter = new RateLimiter({ maxRequests: 2, windowMs: 10_000 })
      limiter.check('client-a')
      limiter.check('client-a')

      // Over limit
      expect(limiter.check('client-a').allowed).toBe(false)

      // Advance past the window
      vi.advanceTimersByTime(10_001)

      // Should be allowed again
      const result = limiter.check('client-a')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses sliding window — old requests expire individually', () => {
    vi.useFakeTimers()
    try {
      limiter = new RateLimiter({ maxRequests: 2, windowMs: 10_000 })

      // t=0: first request
      limiter.check('client-a')

      // t=5s: second request
      vi.advanceTimersByTime(5_000)
      limiter.check('client-a')

      // t=5s: at limit
      expect(limiter.check('client-a').allowed).toBe(false)

      // t=10.001s: first request expired, second still in window
      vi.advanceTimersByTime(5_001)
      const result = limiter.check('client-a')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(0) // 2 in window now (the 5s one + this new one)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RATE_LIMIT_TIERS', () => {
  it('defines expected tiers', () => {
    expect(RATE_LIMIT_TIERS.default.maxRequests).toBe(100)
    expect(RATE_LIMIT_TIERS.strict.maxRequests).toBe(20)
    expect(RATE_LIMIT_TIERS.admin.maxRequests).toBe(5)
    // All windows are 60 seconds
    expect(RATE_LIMIT_TIERS.default.windowMs).toBe(60_000)
    expect(RATE_LIMIT_TIERS.strict.windowMs).toBe(60_000)
    expect(RATE_LIMIT_TIERS.admin.windowMs).toBe(60_000)
  })
})

describe('rateLimit middleware', () => {
  function createTestApp(maxRequests: number) {
    const limiter = new RateLimiter({ maxRequests, windowMs: 60_000 })
    const app = new Hono()
    app.use('/api/*', rateLimit(limiter))
    app.get('/api/test', (c) => c.json({ ok: true }))
    app.get('/no-limit', (c) => c.json({ ok: true }))
    return { app, limiter }
  }

  it('passes requests under the limit with X-RateLimit-Remaining header', async () => {
    const { app, limiter } = createTestApp(5)
    try {
      const res = await app.request(new Request('http://localhost/api/test'))
      expect(res.status).toBe(200)
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('4')
    } finally {
      limiter.dispose()
    }
  })

  it('returns 429 with Retry-After header when limit exceeded', async () => {
    const { app, limiter } = createTestApp(2)
    try {
      // Exhaust the limit
      await app.request(new Request('http://localhost/api/test'))
      await app.request(new Request('http://localhost/api/test'))

      // Third request should be rejected
      const res = await app.request(new Request('http://localhost/api/test'))
      expect(res.status).toBe(429)

      const retryAfter = res.headers.get('Retry-After')
      expect(retryAfter).toBeTruthy()
      expect(Number(retryAfter)).toBeGreaterThan(0)

      const body = await res.json()
      expect(body.error).toBe('Too Many Requests')
      expect(body.message).toContain('Retry after')
    } finally {
      limiter.dispose()
    }
  })

  it('does not rate-limit paths outside the middleware mount', async () => {
    const { app, limiter } = createTestApp(1)
    try {
      // Exhaust limit on /api path
      await app.request(new Request('http://localhost/api/test'))
      const res = await app.request(new Request('http://localhost/api/test'))
      expect(res.status).toBe(429)

      // /no-limit should still work
      const res2 = await app.request(new Request('http://localhost/no-limit'))
      expect(res2.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })

  it('uses X-Forwarded-For header for client identification', async () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 })
    const app = new Hono()
    app.use('/api/*', rateLimit(limiter))
    app.get('/api/test', (c) => c.json({ ok: true }))

    try {
      // First request from IP-A
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Forwarded-For': '10.0.0.1' },
        }),
      )
      expect(res1.status).toBe(200)

      // Second request from IP-A — over limit
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Forwarded-For': '10.0.0.1' },
        }),
      )
      expect(res2.status).toBe(429)

      // Request from IP-B — separate window, should pass
      const res3 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Forwarded-For': '10.0.0.2' },
        }),
      )
      expect(res3.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })
})
