/**
 * Integration tests for the mobile rate-limit tier.
 *
 * Architecture Review Phase 6, Item 6.5 (R8).
 *
 * Verifies that after removing `internal:mobile-app` from BYPASS_CALLERS:
 * a) mobile caller with valid Bearer + public IP → mobile tier, no 429 below threshold
 * b) mobile caller with valid Bearer over threshold → 429
 * c) mobile caller WITHOUT Bearer + public IP → rate-limited (mobile-auth rejects downstream)
 * d) internal:integration-test caller → still bypasses (existing pattern preserved)
 *
 * Also verifies the token-hash bucket semantics: two different tokens get
 * independent buckets, while the same token shares a bucket.
 *
 * Uses RateLimiter directly (no full app bootstrap needed — rate-limit is
 * middleware-tested in isolation, same as the rest of rate-limit.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { RateLimiter, RATE_LIMIT_TIERS, rateLimit } from '../middleware/rate-limit.js'

// -------------------------------------------------------------------------
// Test fixtures
// -------------------------------------------------------------------------

const MOBILE_TOKEN_A = 'test-mobile-bearer-token-alpha-abc123'
const MOBILE_TOKEN_B = 'test-mobile-bearer-token-beta-xyz789'

/** Build expected mobile rate-limit key for a given Bearer token value. */
function mobileKey(token: string): string {
  return `mobile:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
}

/** A public WAN IP that simulates an iPhone behind Cloudflare Tunnel. */
const PUBLIC_IP = '203.0.113.42' // TEST-NET-3, RFC 5737, guaranteed non-internal

/** Make a Request with the standard mobile caller headers. */
function mobileRequest(
  token: string | null,
  ip = PUBLIC_IP,
): Request {
  const headers: Record<string, string> = {
    'X-Open-Brain-Caller': 'mobile-app',
    'X-Forwarded-For': ip,
  }
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return new Request('http://localhost/api/test', { headers })
}

/** Build a test Hono app with the given mobile and base limiters. */
function createTestApp(mobileLimiter: RateLimiter, baseLimiter?: RateLimiter) {
  const base = baseLimiter ?? new RateLimiter({ maxRequests: 100, windowMs: 60_000 })
  const app = new Hono()
  app.use('/api/*', rateLimit(base, mobileLimiter))
  app.get('/api/test', (c) => c.json({ ok: true }))
  return { app, base }
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('mobile rate-limit tier (Phase 6 R8)', () => {
  const disposables: RateLimiter[] = []

  function make(maxRequests: number): RateLimiter {
    const l = new RateLimiter({ maxRequests, windowMs: 60_000 })
    disposables.push(l)
    return l
  }

  afterEach(() => {
    for (const l of disposables) l.dispose()
    disposables.length = 0
  })

  // -----------------------------------------------------------------------
  // Case (a): mobile caller with valid Bearer + public IP → passes under threshold
  // -----------------------------------------------------------------------
  it('(a) mobile caller with valid Bearer + public IP → passes below threshold', async () => {
    // Use a threshold of 5 so we can send 3 requests and confirm all pass.
    const mobileLimiter = make(5)
    const { app } = createTestApp(mobileLimiter)

    for (let i = 0; i < 3; i++) {
      const res = await app.request(mobileRequest(MOBILE_TOKEN_A))
      expect(res.status).toBe(200)
    }
  })

  // -----------------------------------------------------------------------
  // Case (b): mobile caller with valid Bearer over threshold → 429
  // -----------------------------------------------------------------------
  it('(b) mobile caller with valid Bearer over threshold → 429', async () => {
    const mobileLimiter = make(2)
    const { app } = createTestApp(mobileLimiter)

    // Exhaust the mobile bucket
    await app.request(mobileRequest(MOBILE_TOKEN_A))
    await app.request(mobileRequest(MOBILE_TOKEN_A))

    // Third request → 429
    const res = await app.request(mobileRequest(MOBILE_TOKEN_A))
    expect(res.status).toBe(429)

    const body = await res.json() as Record<string, string>
    expect(body.error).toBe('Too Many Requests')
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // Case (c): mobile caller WITHOUT Bearer → rate-limited (falls back to IP key)
  // mobile-auth will reject downstream, but rate-limiter still counts the attempt
  // -----------------------------------------------------------------------
  it('(c) mobile caller without Bearer + public IP → rate-limited via IP key', async () => {
    const mobileLimiter = make(1)
    const { app } = createTestApp(mobileLimiter)

    // First request — no Bearer, but mobile path → IP-keyed mobile bucket (threshold=1)
    const res1 = await app.request(mobileRequest(null))
    expect(res1.status).toBe(200) // passes rate-limit; mobile-auth would reject next in real stack

    // Second request → 429 (same IP bucket exhausted)
    const res2 = await app.request(mobileRequest(null))
    expect(res2.status).toBe(429)
  })

  // -----------------------------------------------------------------------
  // Case (d): internal:integration-test caller → bypasses regardless of limiter
  // -----------------------------------------------------------------------
  it('(d) integration-test caller → bypasses rate-limit (BYPASS_CALLERS intact)', async () => {
    // Set threshold to 1 so any non-bypassed caller would 429 on the second request
    const mobileLimiter = make(1)
    const baseLimiter = make(1)
    const { app } = createTestApp(mobileLimiter, baseLimiter)

    const makeIntegrationTestRequest = () =>
      new Request('http://localhost/api/test', {
        headers: {
          'X-Open-Brain-Caller': 'integration-test',
          // No XFF → direct Docker-network call; isInternalIp() exempts it
        },
      })

    // Send 3 requests — all should bypass
    for (let i = 0; i < 3; i++) {
      const res = await app.request(makeIntegrationTestRequest())
      expect(res.status).toBe(200)
    }
  })

  // -----------------------------------------------------------------------
  // Token bucket isolation: different Bearer tokens → independent buckets
  // -----------------------------------------------------------------------
  it('two different Bearer tokens get independent mobile buckets', async () => {
    const mobileLimiter = make(1)
    const { app } = createTestApp(mobileLimiter)

    // Token A: first request allowed
    const r1 = await app.request(mobileRequest(MOBILE_TOKEN_A))
    expect(r1.status).toBe(200)

    // Token A: second request → 429 (bucket exhausted)
    const r2 = await app.request(mobileRequest(MOBILE_TOKEN_A))
    expect(r2.status).toBe(429)

    // Token B: independent bucket, still allowed
    const r3 = await app.request(mobileRequest(MOBILE_TOKEN_B))
    expect(r3.status).toBe(200)

    // Token B: second request → 429
    const r4 = await app.request(mobileRequest(MOBILE_TOKEN_B))
    expect(r4.status).toBe(429)
  })

  // -----------------------------------------------------------------------
  // Same token from different IPs → same bucket (token-hash keying, not IP)
  // -----------------------------------------------------------------------
  it('same Bearer token from different public IPs → same mobile bucket', async () => {
    const mobileLimiter = make(1)
    const { app } = createTestApp(mobileLimiter)

    // First request from IP A with Token A
    const r1 = await app.request(mobileRequest(MOBILE_TOKEN_A, '203.0.113.1'))
    expect(r1.status).toBe(200)

    // Second request from a DIFFERENT public IP, same token → same bucket, 429
    const r2 = await app.request(mobileRequest(MOBILE_TOKEN_A, '203.0.113.2'))
    expect(r2.status).toBe(429)
  })

  // -----------------------------------------------------------------------
  // mobile-app from an INTERNAL IP → treated as internal:mobile-app (not mobile tier)
  // Even without the bypass entry, the key is 'internal:mobile-app' which is
  // NOT in BYPASS_CALLERS → it falls through to the base limiter, not mobile tier.
  // This is an edge case (iPhone on LAN) — acceptable behavior.
  // -----------------------------------------------------------------------
  it('mobile-app from internal IP → falls through to base limiter (not mobile tier)', async () => {
    const mobileLimiter = make(1000) // high — should not be touched
    const baseLimiter = make(1)     // tight — should fire
    const { app } = createTestApp(mobileLimiter, baseLimiter)

    const internalRequest = (token: string) =>
      new Request('http://localhost/api/test', {
        headers: {
          'X-Open-Brain-Caller': 'mobile-app',
          'X-Forwarded-For': '192.168.1.50', // RFC1918 internal IP
          'Authorization': `Bearer ${token}`,
        },
      })

    // First request — internal:mobile-app key, base limiter (maxRequests=1), passes
    const r1 = await app.request(internalRequest(MOBILE_TOKEN_A))
    expect(r1.status).toBe(200)

    // Second request from same internal IP → base limiter exhausted → 429
    const r2 = await app.request(internalRequest(MOBILE_TOKEN_A))
    expect(r2.status).toBe(429)
  })

  // -----------------------------------------------------------------------
  // Mobile bucket key format sanity check (unit-level)
  // -----------------------------------------------------------------------
  it('mobileKey() produces expected sha256-prefix format', () => {
    const key = mobileKey('my-test-token')
    expect(key).toMatch(/^mobile:[0-9a-f]{16}$/)
  })

  // -----------------------------------------------------------------------
  // mobile tier limit sanity: RATE_LIMIT_TIERS.mobile is 200 req/min
  // -----------------------------------------------------------------------
  it('RATE_LIMIT_TIERS.mobile is 200 req/min (between default 100 and lenient)', () => {
    expect(RATE_LIMIT_TIERS.mobile.maxRequests).toBe(200)
    expect(RATE_LIMIT_TIERS.mobile.windowMs).toBe(60_000)
  })
})
