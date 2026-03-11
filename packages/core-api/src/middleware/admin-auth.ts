import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { logger } from '../lib/logger.js'

/**
 * Resolves the expected admin API token from environment variables.
 * Priority: ADMIN_API_KEY > MCP_BEARER_TOKEN
 * Returns empty string if neither is set.
 */
function getExpectedToken(): string {
  return process.env.ADMIN_API_KEY ?? process.env.MCP_BEARER_TOKEN ?? ''
}

/**
 * Hono middleware that validates Bearer token authentication for admin endpoints.
 *
 * Checks `Authorization: Bearer <token>` against ADMIN_API_KEY env var,
 * falling back to MCP_BEARER_TOKEN if ADMIN_API_KEY is not set.
 *
 * Follows a fail-closed pattern: if no token is configured in the environment,
 * all requests are rejected with 401. This ensures destructive admin endpoints
 * (reset-data, config/reload) are never accidentally left open.
 */
export const adminAuth = (): MiddlewareHandler => async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader) {
    logger.warn({ path: c.req.path }, 'Admin auth: missing Authorization header')
    return c.json({ error: 'Unauthorized', message: 'Missing Authorization header' }, 401)
  }

  if (!authHeader.startsWith('Bearer ')) {
    logger.warn({ path: c.req.path }, 'Admin auth: malformed Authorization header (expected Bearer scheme)')
    return c.json({ error: 'Unauthorized', message: 'Authorization header must use Bearer scheme' }, 401)
  }

  const providedToken = authHeader.slice('Bearer '.length)
  const tokenHash = createHash('sha256').update(providedToken).digest('hex').slice(0, 16)

  const expectedToken = getExpectedToken()

  if (!expectedToken) {
    // No token configured — fail closed (safe default)
    logger.error({ tokenHash }, 'Admin auth: ADMIN_API_KEY not configured — rejecting all requests')
    return c.json({ error: 'Unauthorized', message: 'Admin API key not configured on server' }, 401)
  }

  const providedBuf = Buffer.from(providedToken)
  const expectedBuf = Buffer.from(expectedToken)
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    logger.warn({ tokenHash }, 'Admin auth: invalid token')
    return c.json({ error: 'Unauthorized', message: 'Invalid bearer token' }, 401)
  }

  logger.debug({ tokenHash }, 'Admin auth: accepted')
  await next()
}
