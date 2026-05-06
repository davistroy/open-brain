/**
 * Unit tests for POST /admin/reset-data two-step flow (P04a).
 *
 * Tests:
 *  1. Origin check blocks non-allowed origin in prod mode
 *  2. Origin check allows brain.troy-davis.com
 *  3. Missing Redis → 503 on step 1
 *  4. Token single-use (second use → 401)
 *  5. Expired/missing token → 401
 *  6. Wrong confirmation phrase at step 2 → 400
 *  7. ADMIN_RESET_SKIP_PGDUMP=true full flow success
 *  8. Audit row written on blocked (bad origin)
 *  9. Audit row written on successful wipe
 * 10. admin_audit NOT in TRUNCATE list (code-level assertion)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ── Redis mock setup ──────────────────────────────────────────────────────────

// Store for GETDEL simulation: key → value | null
const redisStore: Map<string, string | null> = new Map()

const mockGet = vi.fn(async (key: string) => redisStore.get(key) ?? null)
const mockSet = vi.fn().mockResolvedValue('OK')
const mockGetdel = vi.fn(async (key: string) => {
  const val = redisStore.get(key) ?? null
  redisStore.delete(key)
  return val
})
const mockDel = vi.fn(async () => 1)

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
    getdel: mockGetdel,
    del: mockDel,
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}))

// ── BullMQ + Bull Board mocks (required for admin router to initialise) ───────

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    clean: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0 }),
  })),
}))

vi.mock('@bull-board/api', () => ({ createBullBoard: vi.fn() }))
vi.mock('@bull-board/api/bullMQAdapter', () => ({ BullMQAdapter: vi.fn() }))
vi.mock('@bull-board/hono', () => ({
  HonoAdapter: vi.fn().mockImplementation(() => ({
    setBasePath: vi.fn(),
    registerPlugin: vi.fn().mockReturnValue(new Hono()),
  })),
}))
vi.mock('@hono/node-server/serve-static', () => ({ serveStatic: vi.fn() }))

// ── DB mock ────────────────────────────────────────────────────────────────────

const insertedAuditRows: unknown[] = []

const mockDb = {
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn(async () => {
        const row = { id: 'mock-audit-id-' + insertedAuditRows.length }
        insertedAuditRows.push(row)
        return [row]
      }),
    }),
  }),
  execute: vi.fn().mockResolvedValue(undefined),
} as any

// ── ConfigService mock ────────────────────────────────────────────────────────

const mockConfigService = {
  reload: vi.fn().mockReturnValue([{ file: 'test.yaml', success: true }]),
  get: vi.fn(),
} as any

// ── Helper: build app ─────────────────────────────────────────────────────────

async function buildApp(options: {
  withRedis?: boolean
  withDb?: boolean
} = {}) {
  vi.resetModules()
  const { createAdminRouter } = await import('../routes/admin.js')
  const { errorHandler } = await import('../middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler())
  const adminRouter = createAdminRouter({
    configService: mockConfigService,
    redisConnection: options.withRedis !== false ? { host: 'localhost', port: 6379 } : undefined,
    db: options.withDb !== false ? mockDb : undefined,
  })
  app.route('/api/v1/admin', adminRouter)
  return app
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /admin/reset-data — two-step flow', () => {
  let app: Hono
  const savedNodeEnv = process.env.NODE_ENV
  const savedSkipPgdump = process.env.ADMIN_RESET_SKIP_PGDUMP

  beforeEach(async () => {
    vi.clearAllMocks()
    redisStore.clear()
    insertedAuditRows.length = 0
    // Reset mocks to default implementations
    mockGetdel.mockImplementation(async (key: string) => {
      const val = redisStore.get(key) ?? null
      redisStore.delete(key)
      return val
    })
    mockSet.mockImplementation(async (_key: string, value: string, _exFlag: string, _ttl: number) => {
      // Extract the actual key and store it
      return 'OK'
    })
    // Default: test mode (dev bypass for origin check)
    process.env.NODE_ENV = 'test'
    process.env.ADMIN_RESET_SKIP_PGDUMP = 'true'
    app = await buildApp()
  })

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv
    process.env.ADMIN_RESET_SKIP_PGDUMP = savedSkipPgdump
  })

  // ── Test 1: Origin check blocks non-allowed origin in production ──────────
  it('1. blocks request from non-allowed origin in production mode', async () => {
    process.env.NODE_ENV = 'production'
    app = await buildApp()

    const res = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://evil.example.com',
      },
      body: JSON.stringify({ intent: 'reset' }),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden')
  })

  // ── Test 2: Origin check allows brain.troy-davis.com ──────────────────────
  it('2. allows request from brain.troy-davis.com in production mode', async () => {
    process.env.NODE_ENV = 'production'
    app = await buildApp()

    // Seed a valid token in the store so we can test step 2 as well as step 1
    const res = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://brain.troy-davis.com',
      },
      body: JSON.stringify({}),
    })

    // Step 1 should succeed (200 with token)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toBeTruthy()
    expect(body.expires_in).toBe(300)
  })

  // ── Test 3: Missing Redis → 503 on step 1 ─────────────────────────────────
  it('3. returns 503 when Redis is not configured (step 1)', async () => {
    app = await buildApp({ withRedis: false })

    const res = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('Redis')
  })

  // ── Test 4: Token single-use (second use → 401) ───────────────────────────
  it('4. token is single-use — second use returns 401', async () => {
    // Step 1: get token — mockSet captures the key for us
    let capturedToken: string | null = null
    mockSet.mockImplementation(async (key: string, value: string, _ex: string, _ttl: number) => {
      // key pattern: admin:reset-token:<token>
      const token = key.replace('admin:reset-token:', '')
      capturedToken = token
      redisStore.set(key, value)
      return 'OK'
    })

    const step1 = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(step1.status).toBe(200)
    const step1Body = await step1.json()
    capturedToken = step1Body.token

    // Step 2 — first use: should succeed
    const step2a = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'WIPE ALL DATA', token: capturedToken }),
    })
    expect(step2a.status).toBe(200)

    // Step 2 — second use with same token: should 401
    const step2b = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'WIPE ALL DATA', token: capturedToken }),
    })
    expect(step2b.status).toBe(401)
    const body2b = await step2b.json()
    expect(body2b.error).toContain('expired')
  })

  // ── Test 5: Expired/missing token → 401 ───────────────────────────────────
  it('5. expired or missing token returns 401', async () => {
    const res = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'WIPE ALL DATA', token: 'nonexistent-token-xyz' }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toContain('expired')
  })

  // ── Test 6: Wrong confirmation phrase → 400 ───────────────────────────────
  it('6. wrong confirmation phrase returns 400', async () => {
    const res = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete everything', token: 'some-token' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Confirmation required')
  })

  // ── Test 7: Full flow success with ADMIN_RESET_SKIP_PGDUMP=true ───────────
  it('7. full flow succeeds with ADMIN_RESET_SKIP_PGDUMP=true', async () => {
    // Capture token from step 1
    let capturedToken: string | null = null
    mockSet.mockImplementation(async (key: string, value: string) => {
      capturedToken = key.replace('admin:reset-token:', '')
      redisStore.set(key, value)
      return 'OK'
    })

    const step1 = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(step1.status).toBe(200)
    capturedToken = (await step1.json()).token

    const step2 = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'WIPE ALL DATA', token: capturedToken }),
    })

    expect(step2.status).toBe(200)
    const body = await step2.json()
    expect(body.cleared).toContain('captures')
    expect(body.preserved).toContain('admin_audit')
    expect(body.backup_path).toContain('SKIPPED-FOR-TESTS')
    expect(body.audit_id).toBeTruthy()
    expect(body.wiped_at).toBeTruthy()
  })

  // ── Test 8: Audit row written on blocked (bad origin) ────────────────────
  it('8. writes audit row when request is blocked by origin check', async () => {
    process.env.NODE_ENV = 'production'
    app = await buildApp()
    insertedAuditRows.length = 0

    await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://evil.example.com',
      },
      body: JSON.stringify({ intent: 'reset' }),
    })

    // An audit row should have been written
    expect(mockDb.insert).toHaveBeenCalled()
    // The insert call should reference admin_audit (the mock captures calls regardless)
    expect(insertedAuditRows.length).toBeGreaterThan(0)
  })

  // ── Test 9: Audit row written on successful wipe ──────────────────────────
  it('9. writes audit row on successful wipe (reset_executed)', async () => {
    insertedAuditRows.length = 0

    // Step 1
    let capturedToken: string | null = null
    mockSet.mockImplementation(async (key: string, value: string) => {
      capturedToken = key.replace('admin:reset-token:', '')
      redisStore.set(key, value)
      return 'OK'
    })

    const step1 = await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    capturedToken = (await step1.json()).token

    // Step 2
    await app.request('/api/v1/admin/reset-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'WIPE ALL DATA', token: capturedToken }),
    })

    // Expect at least 2 audit rows: reset_requested (step 1) + reset_executed (step 2)
    expect(insertedAuditRows.length).toBeGreaterThanOrEqual(2)
  })

  // ── Test 10: admin_audit NOT in TRUNCATE list (code-level assertion) ───────
  // After Phase 5.1 AdminService extraction, the TRUNCATE lives in admin.service.ts.
  // We assert both the service file AND the route file to prevent regressions
  // if the TRUNCATE ever migrates back to the route layer.
  it('10. admin_audit is NOT present in the TRUNCATE statement in admin.service.ts source', () => {
    const adminServicePath = resolve(__dirname, '../services/admin.service.ts')
    const src = readFileSync(adminServicePath, 'utf-8')

    // Find the SQL-level TRUNCATE block (not JSDoc/comment occurrences of "TRUNCATE").
    // Pattern: sql`` template literal immediately followed by whitespace then TRUNCATE.
    // This matches `sql`\n      TRUNCATE ...` but skips prose references.
    const truncateMatch = src.match(/sql`\s*\n\s+TRUNCATE[\s\S]+?CASCADE/)
    expect(truncateMatch).not.toBeNull()

    if (truncateMatch) {
      expect(truncateMatch[0]).not.toMatch(/admin_audit/)
    }
  })

  it('10b. admin_audit is NOT present in TRUNCATE in routes/admin.ts source (regression guard)', () => {
    const adminTsPath = resolve(__dirname, '../routes/admin.ts')
    const src = readFileSync(adminTsPath, 'utf-8')

    // After service extraction, admin.ts should have no TRUNCATE at all.
    // If one ever appears (regression), it must not include admin_audit.
    const truncateMatch = src.match(/TRUNCATE[\s\S]+?CASCADE/)
    if (truncateMatch) {
      expect(truncateMatch[0]).not.toMatch(/admin_audit/)
    }
    // Primary assertion: no TRUNCATE in route file (the service owns it)
    expect(truncateMatch).toBeNull()
  })
})
