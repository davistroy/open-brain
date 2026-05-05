/**
 * Integration tests for the conditional mobile Bearer auth middleware.
 *
 * Verifies that `requireMobileAuthIfMobileCaller` in
 * `packages/core-api/src/middleware/mobile-auth.ts` activates ONLY when
 * `X-Open-Brain-Caller: mobile-app` is present, and is a no-op for all other
 * callers (web-next-public, internal:*, integration-test).
 *
 * Uses `createApp()` so the full middleware stack (rate-limit + mobile-auth)
 * is exercised in-process.  MOBILE_API_KEY is injected via `vi.stubEnv` so
 * the real env is never polluted.
 *
 * Architecture Review Phase 6, Item 6.3.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createApp } from '../app.js'

// ---------------------------------------------------------------------------
// Stub infrastructure dependencies so createApp() bootstraps cleanly.
// Pattern mirrors captures-routes.test.ts / search-routes.test.ts.
// ---------------------------------------------------------------------------

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    disconnect: vi.fn(),
  })),
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

// ---------------------------------------------------------------------------
// Test MOBILE_API_KEY — injected for all tests in this file.
// We use vi.stubEnv so the original value is auto-restored after each test.
// ---------------------------------------------------------------------------
const TEST_MOBILE_KEY = 'test-mobile-bearer-key-abc123'

// A protected route that exists in the real app and handles GET without auth:
// /api/v1/captures — returns 200 (with mock CaptureService) for known callers.
// For mobile-auth tests we care only about the auth layer (4xx vs pass-through),
// not the route handler's business logic, so we test GET /api/v1/captures.
//
// IMPORTANT: createApp() is called without any services injected, so the route
// handler itself will likely 500 or 404 after auth passes (no mock CaptureService).
// We assert only on whether mobile-auth returns 401/503 vs passes through.
// A 401/503 means auth rejected. Any other status (200, 500, 404) means auth passed.

const AUTH_REJECTED_STATUSES = new Set([401, 503])

function authWasRejected(status: number): boolean {
  return AUTH_REJECTED_STATUSES.has(status)
}

describe('requireMobileAuthIfMobileCaller — conditional mobile Bearer auth', () => {
  let app: ReturnType<typeof createApp>

  beforeAll(() => {
    vi.stubEnv('MOBILE_API_KEY', TEST_MOBILE_KEY)
    // createApp with no services — sufficient for middleware-layer tests
    app = createApp({})
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  // ---------------------------------------------------------------------------
  // Case 1: mobile-app caller WITHOUT Bearer token → 401 from mobile-auth
  // ---------------------------------------------------------------------------
  it('mobile-app caller without Authorization header → 401 AUTH_MISSING', async () => {
    const res = await app.request('/api/v1/captures', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
      },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, string>
    expect(body.code).toBe('AUTH_MISSING')
  })

  it('mobile-app caller with wrong Bearer token → 401 AUTH_INVALID', async () => {
    const res = await app.request('/api/v1/captures', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
        Authorization: 'Bearer wrong-token',
      },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, string>
    expect(body.code).toBe('AUTH_INVALID')
  })

  // ---------------------------------------------------------------------------
  // Case 2: mobile-app caller WITH valid Bearer → auth passes (route runs)
  // ---------------------------------------------------------------------------
  it('mobile-app caller with valid Bearer token → auth passes (not 401 or 503)', async () => {
    const res = await app.request('/api/v1/captures', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
        Authorization: `Bearer ${TEST_MOBILE_KEY}`,
      },
    })
    // Auth layer passed — the route handler may 500 (no services injected) or
    // succeed, but it will NOT be 401 or 503 from mobile-auth.
    expect(authWasRejected(res.status)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Case 3: web-next-public caller (no Bearer) → mobile-auth skipped (not 401)
  // ---------------------------------------------------------------------------
  it('web-next-public caller without Bearer → mobile-auth skipped (not 401/503)', async () => {
    const res = await app.request('/api/v1/captures', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'web-next-public',
        // No Authorization header — simulates web-next traffic
      },
    })
    expect(authWasRejected(res.status)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Case 4: integration-test caller → mobile-auth skipped (existing test pattern)
  // ---------------------------------------------------------------------------
  it('integration-test caller without Bearer → mobile-auth skipped (not 401/503)', async () => {
    const res = await app.request('/api/v1/captures', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'integration-test',
        'Content-Type': 'application/json',
      },
    })
    expect(authWasRejected(res.status)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Case 5: internal service caller (workers) → mobile-auth skipped
  // ---------------------------------------------------------------------------
  it('internal workers caller without Bearer → mobile-auth skipped (not 401/503)', async () => {
    const res = await app.request('/api/v1/captures', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'workers',
      },
    })
    expect(authWasRejected(res.status)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Case 6: no caller header at all (default public client) → mobile-auth skipped
  // ---------------------------------------------------------------------------
  it('no X-Open-Brain-Caller header → mobile-auth skipped (not 401/503)', async () => {
    const res = await app.request('/api/v1/captures', {
      method: 'GET',
    })
    expect(authWasRejected(res.status)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Case 7: mobile-app on /api/v1/search (another protected route)
  // ---------------------------------------------------------------------------
  it('mobile-app on /api/v1/search without Bearer → 401 AUTH_MISSING', async () => {
    const res = await app.request('/api/v1/search?q=test', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
      },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, string>
    expect(body.code).toBe('AUTH_MISSING')
  })

  // ---------------------------------------------------------------------------
  // Case 8: mobile-app on /api/v1/commitments (another protected route)
  // ---------------------------------------------------------------------------
  it('mobile-app on /api/v1/commitments without Bearer → 401 AUTH_MISSING', async () => {
    const res = await app.request('/api/v1/commitments', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
      },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, string>
    expect(body.code).toBe('AUTH_MISSING')
  })

  // ---------------------------------------------------------------------------
  // Case 9: mobile-app on /api/v1/settings (protected route)
  // ---------------------------------------------------------------------------
  it('mobile-app on /api/v1/settings without Bearer → 401 AUTH_MISSING', async () => {
    const res = await app.request('/api/v1/settings', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
      },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, string>
    expect(body.code).toBe('AUTH_MISSING')
  })

  // ---------------------------------------------------------------------------
  // Case 10: /mcp is NOT protected by mobile-auth (MCP has its own auth)
  // Verify mobile-app caller on /mcp does NOT get AUTH_MISSING from mobile-auth
  // (it may get a different error from MCP's own auth layer, but not mobile-auth's)
  // ---------------------------------------------------------------------------
  it('mobile-app on /mcp without Bearer → NOT rejected by mobile-auth (MCP has own auth)', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    // If mobile-auth fired on /mcp, we'd get 401 + AUTH_MISSING.
    // MCP's own auth may return 401 too, but with a different body shape.
    // We assert it's NOT the mobile-auth AUTH_MISSING code.
    if (res.status === 401) {
      const body = await res.json() as Record<string, string>
      expect(body.code).not.toBe('AUTH_MISSING')
    }
    // Any other status is fine — mobile-auth did not intercept.
  })

  // ---------------------------------------------------------------------------
  // Case 11: MOBILE_API_KEY unset → mobile-app caller gets 503 AUTH_NOT_CONFIGURED
  // ---------------------------------------------------------------------------
  it('MOBILE_API_KEY unset + mobile-app caller → 503 AUTH_NOT_CONFIGURED', async () => {
    vi.stubEnv('MOBILE_API_KEY', '')
    const appNoKey = createApp({})
    const res = await appNoKey.request('/api/v1/captures', {
      method: 'GET',
      headers: {
        'X-Open-Brain-Caller': 'mobile-app',
        Authorization: 'Bearer anything',
      },
    })
    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, string>
    expect(body.code).toBe('AUTH_NOT_CONFIGURED')
    // Restore for subsequent tests
    vi.stubEnv('MOBILE_API_KEY', TEST_MOBILE_KEY)
  })
})
