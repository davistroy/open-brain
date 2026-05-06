import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { logger } from '@open-brain/shared'

/**
 * Hono middleware that validates Bearer token authentication for mobile API endpoints.
 *
 * Checks `Authorization: Bearer <token>` (case-insensitive header, case-sensitive scheme)
 * against MOBILE_API_KEY env var. Sets `auth_tier = 'mobile'` on the Hono context on
 * success so downstream handlers can gate mobile-specific logic.
 *
 * Fail-closed policy:
 * - MOBILE_API_KEY unset or empty → 503 AUTH_NOT_CONFIGURED (never bypass on missing key).
 * - Missing Authorization header → 401 AUTH_MISSING.
 * - Malformed scheme or empty token → 401 AUTH_INVALID.
 * - Wrong token → 401 AUTH_INVALID (timing-safe compare with length pre-check).
 *
 * Logging: SHA-256 prefix of the provided token only — never the full token, never
 * the expected token.
 */
export const mobileAuth: MiddlewareHandler<{ Variables: { auth_tier: string } }> = async (
  c,
  next,
) => {
  const expectedToken = process.env.MOBILE_API_KEY ?? ''

  // Fail-closed: if not configured, reject with 503 (misconfiguration, not auth failure)
  if (!expectedToken) {
    logger.error({ path: c.req.path }, 'Mobile auth: MOBILE_API_KEY not configured — rejecting all requests')
    return c.json(
      { error: 'Service Unavailable', message: 'Mobile API key not configured on server', code: 'AUTH_NOT_CONFIGURED' },
      503,
    )
  }

  const authHeader = c.req.header('Authorization')

  if (!authHeader) {
    logger.warn({ path: c.req.path }, 'Mobile auth: missing Authorization header')
    return c.json(
      { error: 'Unauthorized', message: 'Missing Authorization header', code: 'AUTH_MISSING' },
      401,
    )
  }

  // RFC 6750: scheme is case-sensitive "Bearer"
  if (!authHeader.startsWith('Bearer ')) {
    logger.warn({ path: c.req.path }, 'Mobile auth: malformed Authorization header (expected Bearer scheme)')
    return c.json(
      { error: 'Unauthorized', message: 'Authorization header must use Bearer scheme', code: 'AUTH_INVALID' },
      401,
    )
  }

  const providedToken = authHeader.slice('Bearer '.length).trim()

  if (!providedToken) {
    logger.warn({ path: c.req.path }, 'Mobile auth: empty token after Bearer prefix')
    return c.json(
      { error: 'Unauthorized', message: 'Bearer token must not be empty', code: 'AUTH_INVALID' },
      401,
    )
  }

  const tokenHash = createHash('sha256').update(providedToken).digest('hex').slice(0, 16)

  const providedBuf = Buffer.from(providedToken)
  const expectedBuf = Buffer.from(expectedToken)

  // Length check BEFORE timingSafeEqual — timingSafeEqual throws on unequal-length buffers.
  // This check itself leaks token length, but that is an accepted trade-off (RFC 6750
  // token lengths are not secret).
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    logger.warn({ tokenHash }, 'Mobile auth: invalid token')
    return c.json(
      { error: 'Unauthorized', message: 'Invalid bearer token', code: 'AUTH_INVALID' },
      401,
    )
  }

  logger.debug({ tokenHash }, 'Mobile auth: accepted')
  c.set('auth_tier', 'mobile')
  await next()
}

/**
 * Conditional wrapper: runs `mobileAuth` only when the request carries
 * `X-Open-Brain-Caller: mobile-app`.
 *
 * All other callers (web-next-public, internal:*, integration-test, missing
 * header) pass through without any Bearer validation.  This preserves the
 * existing access pattern for every non-mobile caller while enforcing Bearer
 * auth for the Expo React Native client.
 *
 * Wire this onto each route prefix that the mobile app needs to reach:
 *   app.use('/api/v1/captures', requireMobileAuthIfMobileCaller)
 *   app.use('/api/v1/captures/*', requireMobileAuthIfMobileCaller)
 *   ...
 *
 * IMPORTANT: Do NOT apply to /mcp — that route has its own auth layer.
 */
export const requireMobileAuthIfMobileCaller: MiddlewareHandler<{ Variables: { auth_tier: string } }> =
  async (c, next) => {
    const caller = c.req.header('x-open-brain-caller')
    if (caller === 'mobile-app') {
      // Delegate to the full mobileAuth middleware — handles all 401/503 paths.
      return mobileAuth(c, next)
    }
    // Non-mobile caller — skip auth entirely, continue to route handler.
    await next()
  }
