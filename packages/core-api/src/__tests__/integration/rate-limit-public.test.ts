/**
 * Integration test — public-IP origin cannot bypass rate-limiter via spoofed caller header.
 *
 * Phase 2.4 of IMPLEMENTATION_PLAN-ARCH-REVIEW.md.
 *
 * Verifies the defense-in-depth behavior added in Phase 2.3 to
 * `packages/core-api/src/middleware/rate-limit.ts`:
 *
 *   - When the first IP in `X-Forwarded-For` is PUBLIC, any client-supplied
 *     `X-Open-Brain-Caller` header is IGNORED and the limiter falls through
 *     to IP-based keying. Strict-tier endpoints (POST /api/v1/captures,
 *     20 req/min) WILL 429 once the per-IP budget is exhausted.
 *
 *   - When the first IP in `X-Forwarded-For` is INTERNAL (RFC1918, Tailscale
 *     CGNAT 100.64.0.0/10, loopback, link-local, IPv6 ULA), the caller
 *     header IS honored; bypass-listed callers ride free.
 *
 * Each test uses distinct synthetic source IPs so the in-memory
 * sliding-window limiter (process-wide singleton in app.ts) does not
 * cross-contaminate.
 *
 * Requires docker-compose.test.yml services to be running.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  initTestDatabase,
  teardownTestDatabase,
  getTestApp,
  type TestAppContext,
} from './setup.js'
import { cleanDatabase } from './helpers.js'

let ctx: TestAppContext

beforeAll(async () => {
  await initTestDatabase()
  ctx = getTestApp()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await cleanDatabase()
})

/**
 * Build a POST /api/v1/captures Request with explicit caller + XFF headers.
 * Note: NO default `X-Open-Brain-Caller: integration-test` here — these tests
 * verify the public-spoof and internal-bypass paths directly, not the global
 * test bypass.
 */
function buildCaptureRequest(opts: {
  caller?: string
  xff?: string
  body?: Record<string, unknown>
}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (opts.caller) headers['X-Open-Brain-Caller'] = opts.caller
  if (opts.xff) headers['X-Forwarded-For'] = opts.xff

  const body = opts.body ?? {
    content: `rate limit public test ${crypto.randomUUID()}`,
    capture_type: 'idea',
    brain_view: 'technical',
    source: 'api',
  }

  return new Request('http://localhost/api/v1/captures', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('Rate limiter — public-IP origin defense-in-depth (Phase 2.3 / 2.4)', () => {
  it('public X-Forwarded-For + spoofed X-Open-Brain-Caller: mobile-app → strict-tier 429 (caller header ignored on public IP)', async () => {
    // Strict tier RateLimiter is configured 20 req/min, but `app.ts` registers it
    // on BOTH `/api/v1/captures` and `/api/v1/captures/*` for the same singleton,
    // so each POST burns 2 slots — the effective per-IP budget is 10 requests.
    // Either way, the property under test is: the 429 fires keyed on the public
    // IP (1.2.3.4), proving the spoofed `X-Open-Brain-Caller: mobile-app` was
    // IGNORED. We send 25 requests and assert 429s appeared.
    const PUBLIC_IP = '1.2.3.4'
    const N = 25

    const statuses: number[] = []
    for (let i = 0; i < N; i++) {
      const res = await ctx.app.fetch(
        buildCaptureRequest({
          caller: 'mobile-app',
          xff: PUBLIC_IP,
        }),
      )
      statuses.push(res.status)
    }

    const first429Index = statuses.findIndex((s) => s === 429)

    // 429 MUST appear within the first 22 requests (well under N=25).
    expect(first429Index).toBeGreaterThan(0)
    expect(first429Index).toBeLessThanOrEqual(22)
    // Every successful response prior to the first 429 must NOT itself be 429.
    expect(statuses.slice(0, first429Index).every((s) => s !== 429)).toBe(true)
    // At least one explicit 429 status (final assertion the bypass was rejected).
    expect(statuses.includes(429)).toBe(true)
  })

  it('public X-Forwarded-For + spoofed caller falls through to IP keying — second public IP gets its own bucket', async () => {
    // After exhausting the 1.2.3.4 bucket in the previous test (limiter state
    // persists across tests within the same process), a second public IP should
    // still have its OWN budget — the first few requests must succeed. This
    // proves the limiter is keying per-IP, not maintaining a global "spoofed
    // caller" bucket. Sample only the first 5 requests (well under the
    // double-counted ~10-request effective budget) to avoid flakiness.
    const PUBLIC_IP_2 = '5.6.7.8'

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.fetch(
        buildCaptureRequest({
          caller: 'mobile-app',
          xff: PUBLIC_IP_2,
        }),
      )
      statuses.push(res.status)
    }

    const count429 = statuses.filter((s) => s === 429).length
    expect(count429).toBe(0)
  })

  it('internal RFC1918 X-Forwarded-For (172.20.0.5) + bypass caller: 30 POSTs all bypass (no 429)', async () => {
    // Docker bridge IP — internal range. Caller is bypass-listed.
    // 30 requests > strict tier 20/min budget; all must succeed (no 429) because
    // the caller header is honored on internal source IP.
    const INTERNAL_IP = '172.20.0.5'

    const statuses: number[] = []
    for (let i = 0; i < 30; i++) {
      const res = await ctx.app.fetch(
        buildCaptureRequest({
          caller: 'integration-test',
          xff: INTERNAL_IP,
        }),
      )
      statuses.push(res.status)
    }

    const count429 = statuses.filter((s) => s === 429).length
    expect(count429).toBe(0)
  })

  it('internal Tailscale CGNAT X-Forwarded-For (100.64.5.10) + bypass caller: 30 POSTs all bypass (no 429)', async () => {
    // 100.64.0.0/10 is the Tailscale carrier-grade NAT range; treated as internal.
    // 30 sequential POSTs with a bypass caller header must all succeed.
    const TAILSCALE_IP = '100.64.5.10'

    const statuses: number[] = []
    for (let i = 0; i < 30; i++) {
      const res = await ctx.app.fetch(
        buildCaptureRequest({
          caller: 'web-ui',
          xff: TAILSCALE_IP,
        }),
      )
      statuses.push(res.status)
    }

    const count429 = statuses.filter((s) => s === 429).length
    expect(count429).toBe(0)
  })

  it('public XFF without caller header → keyed on public IP, exhausts strict tier (sanity check)', async () => {
    // Sanity check: confirm the limiter would have 429ed even without a spoofed
    // caller — proves the public-spoof test above isn't accidentally exercising
    // a different path (e.g., CORS, body validation). 25 sequential POSTs against
    // a fresh public IP MUST trigger at least one 429 (effective budget per
    // app.ts double-registration is ~10 requests).
    const PUBLIC_IP = '9.10.11.12'
    const N = 25

    const statuses: number[] = []
    for (let i = 0; i < N; i++) {
      const res = await ctx.app.fetch(
        buildCaptureRequest({ xff: PUBLIC_IP }),
      )
      statuses.push(res.status)
    }

    expect(statuses.includes(429)).toBe(true)
  })
})
