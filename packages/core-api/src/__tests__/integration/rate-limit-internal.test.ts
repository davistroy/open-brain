/**
 * Integration test — rate-limit internal caller bypass
 *
 * Verifies two invariants:
 * 1. 100 parallel requests with X-Open-Brain-Caller: integration-test all succeed (no 429)
 *    — confirms bypass logic works under concurrent load.
 * 2. Negative control: 100 parallel POST requests WITHOUT the bypass header DO trigger 429s
 *    — confirms the limiter is actually enforcing limits, not vacuously absent.
 *
 * Requires docker-compose.test.yml to be running.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

describe('Internal caller bypass under 100-parallel load', () => {
  it('100 parallel GET /api/v1/captures with X-Open-Brain-Caller: integration-test all succeed (no 429)', async () => {
    await cleanDatabase()

    const N = 100
    const requests = Array.from({ length: N }, () =>
      ctx.app.fetch(
        new Request('http://localhost/api/v1/captures', {
          headers: {
            'Content-Type': 'application/json',
            'X-Open-Brain-Caller': 'integration-test',
          },
        }),
      ),
    )
    const responses = await Promise.all(requests)
    const count429 = responses.filter(r => r.status === 429).length
    expect(count429).toBe(0)
    expect(responses.every(r => r.status === 200)).toBe(true)
  })

  it('negative control: POST without bypass header DOES 429 after strict-tier exhaustion', async () => {
    await cleanDatabase()

    // Strict tier limit is 20/min for POST /api/v1/captures (no X-Open-Brain-Caller)
    // Send 100 concurrent POST requests — at least some should 429
    const N = 100
    const requests = Array.from({ length: N }, () =>
      ctx.app.fetch(
        new Request('http://localhost/api/v1/captures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'rate limit test capture',
            capture_type: 'idea',
            brain_view: 'technical',
            source: 'api',
          }),
        }),
      ),
    )
    const responses = await Promise.all(requests)
    const count429 = responses.filter(r => r.status === 429).length
    // Strict limiter is 20/min — with 100 parallel requests some must 429
    expect(count429).toBeGreaterThan(0)
  })
})
