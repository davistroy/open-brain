import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { RateLimiter, rateLimit, RATE_LIMIT_TIERS, isInternalIp } from '../middleware/rate-limit.js'

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

  it('uses X-Open-Brain-Caller header for internal service identification', async () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 })
    const app = new Hono()
    app.use('/api/*', rateLimit(limiter))
    app.get('/api/test', (c) => c.json({ ok: true }))

    try {
      // P07: slack-bot and workers are now bypassed — always succeed regardless of limit
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Open-Brain-Caller': 'slack-bot' },
        }),
      )
      expect(res1.status).toBe(200)

      // slack-bot bypassed — second call also succeeds (no 429)
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Open-Brain-Caller': 'slack-bot' },
        }),
      )
      expect(res2.status).toBe(200)

      // Use a non-bypassed caller to verify bucketing: 'custom-service' has its own bucket
      const res3a = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Open-Brain-Caller': 'custom-service' },
        }),
      )
      expect(res3a.status).toBe(200)

      // custom-service over limit
      const res3b = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Open-Brain-Caller': 'custom-service' },
        }),
      )
      expect(res3b.status).toBe(429)

      // default-client (no headers) also has its own bucket — still allowed since different bucket
      const res4 = await app.request(new Request('http://localhost/api/test'))
      expect(res4.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })

  it('X-Open-Brain-Caller takes priority over X-Forwarded-For', async () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 })
    const app = new Hono()
    app.use('/api/*', rateLimit(limiter))
    app.get('/api/test', (c) => c.json({ ok: true }))

    try {
      // Use a non-bypassed caller to verify caller header takes priority over X-Forwarded-For
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'custom-service',
            'X-Forwarded-For': '10.0.0.2',
          },
        }),
      )
      expect(res1.status).toBe(200)

      // Same caller over limit (separate bucket from IP)
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'custom-service',
            'X-Forwarded-For': '10.0.0.2',
          },
        }),
      )
      expect(res2.status).toBe(429)

      // Same forwarded-for IP without caller header — different bucket, allowed
      const res3 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Forwarded-For': '10.0.0.2' },
        }),
      )
      expect(res3.status).toBe(200)

      // P07: slack-bot is bypassed — always succeeds even when caller-bucket is exhausted
      const res4 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'slack-bot',
            'X-Forwarded-For': '10.0.0.2',
          },
        }),
      )
      expect(res4.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })
})

describe('isInternalIp predicate', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.20.0.5', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['192.168.255.255', true],
    ['100.64.0.0', true],
    ['100.64.10.5', true],
    ['100.127.255.255', true],
    ['169.254.1.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['fe80::abcd:1234', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['::ffff:10.0.0.1', true],
    // Public IPs (not internal)
    ['1.2.3.4', false],
    ['8.8.8.8', false],
    ['172.15.0.1', false], // just below 172.16
    ['172.32.0.1', false], // just above 172.31
    ['100.63.255.255', false], // just below CGNAT
    ['100.128.0.0', false], // just above CGNAT
    ['192.169.0.1', false],
    ['11.0.0.1', false],
    ['126.255.255.255', false],
    ['128.0.0.1', false],
    ['', false],
    ['not-an-ip', false],
    ['256.0.0.1', false],
    ['2001:4860:4860::8888', false], // Google DNS v6
  ])('isInternalIp(%j) === %s', (ip, expected) => {
    expect(isInternalIp(ip)).toBe(expected)
  })
})

describe('rateLimit middleware — defense-in-depth caller header (Phase 2.3)', () => {
  function createApp(maxRequests: number) {
    const limiter = new RateLimiter({ maxRequests, windowMs: 60_000 })
    const app = new Hono()
    app.use('/api/*', rateLimit(limiter))
    app.get('/api/test', (c) => c.json({ ok: true }))
    return { app, limiter }
  }

  it('honors X-Open-Brain-Caller: integration-test from 127.0.0.1 (loopback)', async () => {
    const { app, limiter } = createApp(1)
    try {
      // integration-test is in BYPASS_CALLERS — should bypass entirely
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'integration-test',
            'X-Forwarded-For': '127.0.0.1',
          },
        }),
      )
      expect(res1.status).toBe(200)
      // Second call also bypasses (no 429)
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'integration-test',
            'X-Forwarded-For': '127.0.0.1',
          },
        }),
      )
      expect(res2.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })

  it('honors X-Open-Brain-Caller: workers from 172.20.0.5 (RFC1918 Docker-typical)', async () => {
    const { app, limiter } = createApp(1)
    try {
      // workers is in BYPASS_CALLERS — bypasses with internal source IP
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'workers',
            'X-Forwarded-For': '172.20.0.5',
          },
        }),
      )
      expect(res1.status).toBe(200)
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'workers',
            'X-Forwarded-For': '172.20.0.5',
          },
        }),
      )
      expect(res2.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })

  it('honors X-Open-Brain-Caller: web-ui from 100.64.10.5 (Tailscale CGNAT)', async () => {
    const { app, limiter } = createApp(1)
    try {
      // web-ui is in BYPASS_CALLERS — bypasses with Tailscale source IP
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'web-ui',
            'X-Forwarded-For': '100.64.10.5',
          },
        }),
      )
      expect(res1.status).toBe(200)
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'web-ui',
            'X-Forwarded-For': '100.64.10.5',
          },
        }),
      )
      expect(res2.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })

  it('IGNORES X-Open-Brain-Caller: mobile-app from 1.2.3.4 (public IP) — falls through to IP key', async () => {
    const { app, limiter } = createApp(1)
    try {
      // mobile-app is in BYPASS_CALLERS, but source IP 1.2.3.4 is public → caller header ignored.
      // First request keys on '1.2.3.4', allowed.
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'mobile-app',
            'X-Forwarded-For': '1.2.3.4',
          },
        }),
      )
      expect(res1.status).toBe(200)
      // Second request with same public IP → over limit (proves we did NOT bypass).
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'mobile-app',
            'X-Forwarded-For': '1.2.3.4',
          },
        }),
      )
      expect(res2.status).toBe(429)
    } finally {
      limiter.dispose()
    }
  })

  it('IGNORES X-Open-Brain-Caller: workers from 8.8.8.8 (public IP) — falls through to IP key', async () => {
    const { app, limiter } = createApp(1)
    try {
      // workers is in BYPASS_CALLERS, but source IP 8.8.8.8 is public → caller header ignored.
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'workers',
            'X-Forwarded-For': '8.8.8.8',
          },
        }),
      )
      expect(res1.status).toBe(200)
      // Second request from same public IP → 429 (caller bypass NOT applied).
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: {
            'X-Open-Brain-Caller': 'workers',
            'X-Forwarded-For': '8.8.8.8',
          },
        }),
      )
      expect(res2.status).toBe(429)
    } finally {
      limiter.dispose()
    }
  })

  it('honors X-Open-Brain-Caller without X-Forwarded-For (direct Docker-network call)', async () => {
    const { app, limiter } = createApp(1)
    try {
      // No XFF → request did not transit a reverse proxy. In production, only
      // the Docker network can reach core-api directly. Caller header honored.
      const res1 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Open-Brain-Caller': 'workers' },
        }),
      )
      expect(res1.status).toBe(200)
      const res2 = await app.request(
        new Request('http://localhost/api/test', {
          headers: { 'X-Open-Brain-Caller': 'workers' },
        }),
      )
      expect(res2.status).toBe(200)
    } finally {
      limiter.dispose()
    }
  })
})
