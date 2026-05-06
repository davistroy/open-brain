/**
 * Shared test helpers for core-api route tests.
 *
 * Phase 3.1 of IMPLEMENTATION_PLAN-ARCH-REVIEW.md — created so 3.2-3.6 (16 new
 * route test files) have one consistent way to bootstrap a Hono app under test.
 *
 * Existing tests are NOT migrated by this work item; they'll adopt these
 * helpers as new tests are written.
 */
import { Hono } from 'hono'
import { vi, type Mock } from 'vitest'
import { errorHandler } from '../middleware/error-handler.js'

/**
 * Default headers for all test requests. Includes the rate-limit bypass
 * caller header so tests don't 429 under burst load.
 *
 * NOTE: tests run from 127.0.0.1 (loopback), which is treated as internal
 * by isInternalIp() — so the X-Open-Brain-Caller bypass is honored.
 * If you ever need to simulate a public client, override X-Forwarded-For
 * to a non-RFC1918/non-CGNAT address.
 */
export const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'X-Open-Brain-Caller': 'integration-test',
} as const

/**
 * Build a fully-mocked service surface using vi.fn() for every method
 * declared on the type. Returns an object whose methods are vi.Mock
 * instances, so tests can `.mockResolvedValue(...)` etc.
 *
 * Usage:
 *   const betService = makeMockService<BetService>(['list', 'get', 'create', 'resolve'])
 *   betService.list.mockResolvedValue([{...}])
 */
export function makeMockService<T>(methods: ReadonlyArray<keyof T>): {
  [K in keyof T]: Mock
} {
  const mock = {} as Record<string, Mock>
  for (const method of methods) {
    mock[method as string] = vi.fn()
  }
  return mock as { [K in keyof T]: Mock }
}

/**
 * Build a Hono test app from a route mounter, with the canonical
 * errorHandler() registered. Use this instead of bare `new Hono()` so
 * AppError throws produce {error, code} JSON at the right status.
 *
 * `errorHandler` is exported as a factory from
 * `packages/core-api/src/middleware/error-handler.ts` — it must be invoked
 * (`errorHandler()`) to produce the `ErrorHandler` that `app.onError` expects.
 *
 * Usage:
 *   const app = makeTestApp(app => app.route('/bets', betRoutes(deps)))
 *   const res = await app.request('/bets', { headers: DEFAULT_HEADERS })
 */
export function makeTestApp(mount: (app: Hono) => Hono | void): Hono {
  const app = new Hono()
  app.onError(errorHandler())
  mount(app)
  return app
}

/**
 * Convenience: send a JSON request to a Hono app and parse the response.
 * Merges DEFAULT_HEADERS so callers don't have to repeat them.
 *
 * Usage:
 *   const { status, body } = await testJson(app, '/captures', {
 *     method: 'POST',
 *     body: JSON.stringify({ content: 'hello' }),
 *   })
 */
export async function testJson(
  app: Hono,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const headers = {
    ...DEFAULT_HEADERS,
    ...((init.headers ?? {}) as Record<string, string>),
  }
  const res = await app.request(path, { ...init, headers })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}
