import { createHash } from 'node:crypto'
import { logger } from '../lib/logger.js'

/**
 * Validates the MCP Bearer token from the Authorization header.
 *
 * Checks the Authorization: Bearer <token> header against MCP_BEARER_TOKEN env var.
 * Logs auth attempts using a SHA-256 hash of the provided token — never the token itself.
 *
 * Returns null on success, or an error Response (401) on failure.
 */
export function validateMcpAuth(request: Request): Response | null {
  const expectedToken = process.env.MCP_BEARER_TOKEN ?? process.env.MCP_API_KEY ?? ''

  const authHeader = request.headers.get('Authorization')

  if (!authHeader) {
    logger.warn({ path: new URL(request.url).pathname }, 'MCP auth: missing Authorization header')
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!authHeader.startsWith('Bearer ')) {
    logger.warn({ path: new URL(request.url).pathname }, 'MCP auth: malformed Authorization header (expected Bearer scheme)')
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Authorization header must use Bearer scheme' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const providedToken = authHeader.slice('Bearer '.length)
  const tokenHash = createHash('sha256').update(providedToken).digest('hex').slice(0, 16)

  if (!expectedToken) {
    // No token configured — fail closed (safe default)
    logger.error({ tokenHash }, 'MCP auth: MCP_BEARER_TOKEN not configured — rejecting all requests')
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'MCP bearer token not configured on server' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (providedToken !== expectedToken) {
    logger.warn({ tokenHash }, 'MCP auth: invalid token')
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Invalid bearer token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  logger.debug({ tokenHash }, 'MCP auth: accepted')
  return null
}
