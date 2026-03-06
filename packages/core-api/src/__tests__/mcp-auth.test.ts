import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { validateMcpAuth } from '../mcp/auth.js'

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authHeader !== undefined) {
    headers['Authorization'] = authHeader
  }
  return new Request('http://localhost/mcp', { method: 'POST', headers })
}

describe('validateMcpAuth', () => {
  const originalEnv = process.env.MCP_BEARER_TOKEN

  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = 'test-secret-token'
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCP_BEARER_TOKEN
    } else {
      process.env.MCP_BEARER_TOKEN = originalEnv
    }
  })

  it('returns null (success) for valid Bearer token', () => {
    const req = makeRequest('Bearer test-secret-token')
    const result = validateMcpAuth(req)
    expect(result).toBeNull()
  })

  it('returns 401 when Authorization header is missing', async () => {
    const req = makeRequest()
    const result = validateMcpAuth(req)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
    const body = await result!.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 for invalid token', async () => {
    const req = makeRequest('Bearer wrong-token')
    const result = validateMcpAuth(req)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
    const body = await result!.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when Authorization header uses wrong scheme', async () => {
    const req = makeRequest('Basic dXNlcjpwYXNz')
    const result = validateMcpAuth(req)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('returns 401 when MCP_BEARER_TOKEN is not configured', async () => {
    delete process.env.MCP_BEARER_TOKEN
    delete process.env.MCP_API_KEY
    const req = makeRequest('Bearer anything')
    const result = validateMcpAuth(req)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('also checks MCP_API_KEY fallback env var', () => {
    delete process.env.MCP_BEARER_TOKEN
    process.env.MCP_API_KEY = 'fallback-key'
    const req = makeRequest('Bearer fallback-key')
    const result = validateMcpAuth(req)
    expect(result).toBeNull()
    delete process.env.MCP_API_KEY
  })
})
