/**
 * Phase 4.4 — insurance-policies route unit tests.
 *
 * Covers `packages/core-api/src/routes/insurance-policies.ts`:
 *   GET /api/v1/insurance-policies
 *     ?policy_type=health|auto|home|umbrella   — filter by type (optional)
 *     ?active_only=true|false                  — date-range filter (default true)
 *
 * DI strategy:
 *   - `makeTestApp` + `registerInsurancePoliciesRoutes(app, db)` from helpers.ts.
 *   - `db` is a focused mock that only implements the Drizzle chain used by
 *     the route: `db.select().from().where?(and(...))` → rows.
 *   - Two resolution paths: with `.where()` (filtered) or without (unfiltered).
 *   - The route passes Drizzle column refs and ORM conditions to where(); we
 *     don't assert on the exact SQL conditions — only on result forwarding and
 *     the 400 path for invalid policy_type.
 *
 * DI gaps surfaced:
 *   - Route imports `eq`, `gte`, `lte`, `isNull`, `or`, `and` from drizzle-orm
 *     and `insurancePolicies` schema at module scope — not injectable. Acceptable
 *     for a read-only route that has no business logic beyond the filter.
 *   - A future InsurancePolicyService would encapsulate the Drizzle query and
 *     make this route trivially testable with a single mock surface (Phase 5).
 */
import { describe, it, expect, vi } from 'vitest'
import { registerInsurancePoliciesRoutes } from '../routes/insurance-policies.js'
import { makeTestApp, testJson } from './helpers.js'

// ---------------------------------------------------------------------------
// Sample policies
// ---------------------------------------------------------------------------

const HEALTH_POLICY = {
  id: 'pol-health-1',
  policy_number: 'HSP-2026-001',
  provider: 'BlueCross',
  policy_type: 'health',
  effective_date: '2026-01-01',
  expiration_date: '2026-12-31',
  insured_name: 'Troy Davis',
  coverage: { deductible: 1500, out_of_pocket_max: 5000 },
  raw_text: null,
  source_file: 'health-policy-2026.pdf',
  extracted_at: new Date('2026-01-15T09:00:00Z'),
  created_at: new Date('2026-01-15T09:00:00Z'),
}

const AUTO_POLICY = {
  id: 'pol-auto-1',
  policy_number: 'AUT-2026-001',
  provider: 'GEICO',
  policy_type: 'auto',
  effective_date: '2026-03-01',
  expiration_date: '2027-02-28',
  insured_name: 'Troy Davis',
  coverage: { liability: 100000, collision: true, comprehensive: true },
  raw_text: null,
  source_file: 'auto-policy-2026.pdf',
  extracted_at: new Date('2026-03-01T09:00:00Z'),
  created_at: new Date('2026-03-01T09:00:00Z'),
}

const EXPIRED_POLICY = {
  ...HEALTH_POLICY,
  id: 'pol-health-old',
  policy_number: 'HSP-2025-001',
  effective_date: '2025-01-01',
  expiration_date: '2025-12-31',
}

// ---------------------------------------------------------------------------
// Mock DB factory
//
// The insurance-policies route uses one of two call forms:
//   1. db.select().from(insurancePolicies)                    — no conditions
//   2. db.select().from(insurancePolicies).where(and(...))    — with conditions
//
// We build a mock that handles both via a shared terminal mock.
// The `where()` call is optional — when absent the `from()` call itself
// resolves via thenable (Promise-like via `.then`).
// ---------------------------------------------------------------------------

function makeMockDb(rows: unknown[] = [HEALTH_POLICY]) {
  // Terminal: resolves to rows regardless of whether .where() was called.
  const resolvedPromise = Promise.resolve(rows)

  // The .where() mock wraps the same resolved rows.
  const whereMock = vi.fn().mockReturnValue(resolvedPromise)

  // .from() returns a thenable (so `await db.select().from()` works)
  // AND exposes .where() so callers can chain further.
  const fromResult = Object.assign(resolvedPromise, { where: whereMock })
  const fromMock = vi.fn().mockReturnValue(fromResult)

  const selectMock = vi.fn().mockReturnValue({ from: fromMock })

  const db = { select: selectMock } as never

  return { db, selectMock, fromMock, whereMock }
}

// ---------------------------------------------------------------------------
// App factory helpers
// ---------------------------------------------------------------------------

function buildApp(rows: unknown[] = [HEALTH_POLICY]) {
  const { db, ...mocks } = makeMockDb(rows)
  const app = makeTestApp((a) => {
    registerInsurancePoliciesRoutes(a, db)
  })
  return { app, ...mocks }
}

// ---------------------------------------------------------------------------
// GET /api/v1/insurance-policies — default (active_only=true)
// ---------------------------------------------------------------------------

describe('GET /api/v1/insurance-policies — default active_only', () => {
  it('returns 200 with policies array', async () => {
    const { app } = buildApp([HEALTH_POLICY])

    const { status, body } = await testJson(app, '/api/v1/insurance-policies')
    const b = body as { policies: typeof HEALTH_POLICY[] }

    expect(status).toBe(200)
    expect(Array.isArray(b.policies)).toBe(true)
    expect(b.policies).toHaveLength(1)
    expect(b.policies[0].policy_type).toBe('health')
  })

  it('calls db.select() to query the insurance_policies table', async () => {
    const { app, selectMock } = buildApp([HEALTH_POLICY])

    await testJson(app, '/api/v1/insurance-policies')

    expect(selectMock).toHaveBeenCalledOnce()
  })

  it('returns empty policies array when no rows exist', async () => {
    const { app } = buildApp([])

    const { status, body } = await testJson(app, '/api/v1/insurance-policies')
    const b = body as { policies: unknown[] }

    expect(status).toBe(200)
    expect(b.policies).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/insurance-policies?active_only=false — unfiltered
// ---------------------------------------------------------------------------

describe('GET /api/v1/insurance-policies — active_only=false', () => {
  it('returns all policies including expired ones', async () => {
    const { app } = buildApp([HEALTH_POLICY, AUTO_POLICY, EXPIRED_POLICY])

    const { status, body } = await testJson(
      app,
      '/api/v1/insurance-policies?active_only=false',
    )
    const b = body as { policies: unknown[] }

    expect(status).toBe(200)
    expect(b.policies).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/insurance-policies?policy_type=auto — type filter
// ---------------------------------------------------------------------------

describe('GET /api/v1/insurance-policies — policy_type filter', () => {
  it('accepts valid policy_type=auto', async () => {
    const { app } = buildApp([AUTO_POLICY])

    const { status, body } = await testJson(
      app,
      '/api/v1/insurance-policies?policy_type=auto',
    )
    const b = body as { policies: typeof AUTO_POLICY[] }

    expect(status).toBe(200)
    expect(b.policies[0].policy_type).toBe('auto')
  })

  it('rejects invalid policy_type with 400', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(
      app,
      '/api/v1/insurance-policies?policy_type=boat',
    )
    const b = body as { error?: string; valid_types?: string[] }

    expect(status).toBe(400)
    expect(b.error).toBe('Invalid policy_type')
    expect(b.valid_types).toContain('health')
    expect(b.valid_types).toContain('auto')
    expect(b.valid_types).toContain('home')
    expect(b.valid_types).toContain('umbrella')
  })

  it('rejects invalid policy_type without calling db.select()', async () => {
    const { app, selectMock } = buildApp()

    await testJson(app, '/api/v1/insurance-policies?policy_type=life')

    expect(selectMock).not.toHaveBeenCalled()
  })

  it('accepts all four valid policy_type values', async () => {
    for (const ptype of ['health', 'auto', 'home', 'umbrella']) {
      const { app } = buildApp([])

      const { status } = await testJson(
        app,
        `/api/v1/insurance-policies?policy_type=${ptype}`,
      )

      expect(status).toBe(200)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/insurance-policies — combined filters
// ---------------------------------------------------------------------------

describe('GET /api/v1/insurance-policies — combined policy_type + active_only', () => {
  it('combines policy_type and active_only=false', async () => {
    const { app } = buildApp([HEALTH_POLICY, EXPIRED_POLICY])

    const { status, body } = await testJson(
      app,
      '/api/v1/insurance-policies?policy_type=health&active_only=false',
    )
    const b = body as { policies: unknown[] }

    expect(status).toBe(200)
    expect(b.policies).toHaveLength(2)
  })
})
