import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { adminAuth } from '../middleware/admin-auth.js'

/**
 * Creates a minimal Hono app with a single POST route protected by adminAuth middleware.
 */
function createTestApp(): Hono {
  const app = new Hono()
  app.post('/admin/protected', adminAuth(), (c) => c.json({ ok: true }))
  app.get('/admin/open', (c) => c.json({ ok: true }))
  return app
}

function makeRequest(path: string, authHeader?: string, method: string = 'POST'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authHeader !== undefined) {
    headers['Authorization'] = authHeader
  }
  return new Request(`http://localhost${path}`, { method, headers })
}

describe('adminAuth middleware', () => {
  const savedAdminApiKey = process.env.ADMIN_API_KEY
  const savedMcpBearerToken = process.env.MCP_BEARER_TOKEN

  beforeEach(() => {
    // Start with a known token configured
    process.env.ADMIN_API_KEY = 'test-admin-secret'
    delete process.env.MCP_BEARER_TOKEN
  })

  afterEach(() => {
    // Restore original env
    if (savedAdminApiKey === undefined) {
      delete process.env.ADMIN_API_KEY
    } else {
      process.env.ADMIN_API_KEY = savedAdminApiKey
    }
    if (savedMcpBearerToken === undefined) {
      delete process.env.MCP_BEARER_TOKEN
    } else {
      process.env.MCP_BEARER_TOKEN = savedMcpBearerToken
    }
  })

  it('returns 200 for valid Bearer token', async () => {
    const app = createTestApp()
    const res = await app.request(makeRequest('/admin/protected', 'Bearer test-admin-secret'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 401 when Authorization header is missing', async () => {
    const app = createTestApp()
    const res = await app.request(makeRequest('/admin/protected'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
    expect(body.message).toContain('Missing')
  })

  it('returns 401 for invalid token', async () => {
    const app = createTestApp()
    const res = await app.request(makeRequest('/admin/protected', 'Bearer wrong-token'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
    expect(body.message).toContain('Invalid')
  })

  it('returns 401 when Authorization header uses wrong scheme', async () => {
    const app = createTestApp()
    const res = await app.request(makeRequest('/admin/protected', 'Basic dXNlcjpwYXNz'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
    expect(body.message).toContain('Bearer')
  })

  it('returns 401 when no token env var is configured (fail-closed)', async () => {
    delete process.env.ADMIN_API_KEY
    delete process.env.MCP_BEARER_TOKEN
    const app = createTestApp()
    const res = await app.request(makeRequest('/admin/protected', 'Bearer anything'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
    expect(body.message).toContain('not configured')
  })

  it('falls back to MCP_BEARER_TOKEN when ADMIN_API_KEY is not set', async () => {
    delete process.env.ADMIN_API_KEY
    process.env.MCP_BEARER_TOKEN = 'mcp-fallback-token'
    const app = createTestApp()
    const res = await app.request(makeRequest('/admin/protected', 'Bearer mcp-fallback-token'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('prefers ADMIN_API_KEY over MCP_BEARER_TOKEN', async () => {
    process.env.ADMIN_API_KEY = 'admin-key'
    process.env.MCP_BEARER_TOKEN = 'mcp-key'
    const app = createTestApp()

    // MCP token should be rejected when ADMIN_API_KEY is set
    const res1 = await app.request(makeRequest('/admin/protected', 'Bearer mcp-key'))
    expect(res1.status).toBe(401)

    // ADMIN_API_KEY should be accepted
    const res2 = await app.request(makeRequest('/admin/protected', 'Bearer admin-key'))
    expect(res2.status).toBe(200)
  })

  it('does not affect unprotected routes', async () => {
    const app = createTestApp()
    // GET /admin/open has no middleware
    const res = await app.request(makeRequest('/admin/open', undefined, 'GET'))
    expect(res.status).toBe(200)
  })
})
