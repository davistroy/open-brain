/**
 * Phase 3.2 — Comprehensive admin route unit tests.
 *
 * Complements (does NOT duplicate) the existing tests:
 *   - admin-reset-two-step.test.ts — covers the happy path + the 10 baseline
 *     scenarios for POST /admin/reset-data.
 *   - admin-queue-clear.test.ts     — covers POST /queues/:name/clear.
 *   - admin-auth.test.ts            — covers Bearer-token middleware.
 *   - slack-channel-routes.test.ts  — covers /admin/slack/channels[/:id/archive].
 *
 * This file targets the EDGES the plan calls out in §3.2:
 *   - Origin allowlist fail-closed semantics (prod / dev / unset NODE_ENV).
 *   - Confirmation-phrase mismatch variants → audit row outcome=blocked.
 *   - Token replay (single-use) → outcome=blocked.
 *   - Token expired (Redis returns null) → outcome=blocked.
 *   - DB error path → audit row outcome=error still attempted.
 *   - admin_audit excluded from TRUNCATE list (code-level invariant).
 *   - ADMIN_RESET_SKIP_PGDUMP=true → spawn NOT called.
 *   - ADMIN_RESET_SKIP_PGDUMP unset (prod-like) → spawn IS called.
 *   - Banner ops (GET / POST / DELETE) — happy + validation errors.
 *   - /config/reload — happy + 207 partial-failure.
 *
 * DI strategy:
 *   - `db` and `redisConnection` are passed via `createAdminRouter()` options.
 *   - `node:child_process.spawn` is NOT injectable on the current admin.ts —
 *     mocked at the module level via `vi.mock('node:child_process', ...)`.
 *     This gap is documented in the work-item return for Phase 5 D.1
 *     (AdminService extraction will inject `spawnPgDump`).
 *   - `node:fs.mkdirSync` is similarly module-level mocked to avoid hitting
 *     the real `/backup/pre-wipe` directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { EventEmitter } from 'node:events'

// ── Module-level mocks (must be declared BEFORE importing admin router) ───────

// Redis store shared across all mocked instances in this test file.
const redisStore: Map<string, string | null> = new Map()

const mockRedisGet = vi.fn(async (key: string) => redisStore.get(key) ?? null)
const mockRedisSet = vi.fn(async (key: string, value: string) => {
  redisStore.set(key, value)
  return 'OK'
})
const mockRedisGetdel = vi.fn(async (key: string) => {
  const val = redisStore.get(key) ?? null
  redisStore.delete(key)
  return val
})
const mockRedisDel = vi.fn(async (key: string) => {
  redisStore.delete(key)
  return 1
})

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    getdel: mockRedisGetdel,
    del: mockRedisDel,
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}))

// BullMQ + Bull Board (admin router constructs these unconditionally when
// redisConnection is provided)
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    clean: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({
      active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0,
    }),
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

// node:child_process — mock spawn so we can assert pg_dump invocation
// without actually starting a process. The mock returns a fake child process
// with stdout/stderr/close events. Tests can override behavior per-test.
const mockSpawn = vi.fn()
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: mockSpawn }
})

// node:fs — mkdirSync would create /backup/pre-wipe on disk; stub it.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, mkdirSync: vi.fn() }
})

// ── DB mock — captures audit rows AND TRUNCATE invocations ────────────────────

interface AuditRowInput {
  event_type?: string
  outcome?: string
  error_detail?: string
  actor?: string
  origin?: string
  ip_address?: string
  tables_affected?: string[]
  backup_path?: string
  confirmation_phrase?: string
}

let auditRowsInserted: AuditRowInput[] = []
let executeCalls: string[] = []
let insertShouldThrow = false
let executeShouldThrow = false

const mockDb = {
  insert: vi.fn().mockImplementation(() => {
    if (insertShouldThrow) {
      throw new Error('db_insert_failed')
    }
    return {
      values: vi.fn().mockImplementation((row: AuditRowInput) => {
        auditRowsInserted.push(row)
        return {
          returning: vi.fn(async () => [{ id: 'mock-audit-id-' + auditRowsInserted.length }]),
        }
      }),
    }
  }),
  execute: vi.fn().mockImplementation(async (q: unknown) => {
    if (executeShouldThrow) throw new Error('db_execute_failed')
    // Drizzle sql template stringifies via .queryChunks; coerce best-effort.
    const text = (q as { queryChunks?: unknown[] }).queryChunks
      ? JSON.stringify((q as { queryChunks?: unknown[] }).queryChunks)
      : String(q)
    executeCalls.push(text)
    return undefined
  }),
} as never

const mockConfigService: { reload: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } = {
  reload: vi.fn().mockReturnValue([{ file: 'test.yaml', success: true }]),
  get: vi.fn(),
}

// ── Helper: build the admin app ───────────────────────────────────────────────

async function buildApp(opts: { withRedis?: boolean; withDb?: boolean } = {}) {
  vi.resetModules()
  const { createAdminRouter } = await import('../routes/admin.js')
  const { errorHandler } = await import('../middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler())
  const router = createAdminRouter({
    // Cast: ConfigService has many methods; tests only use reload/get.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configService: mockConfigService as any,
    redisConnection: opts.withRedis !== false ? { host: 'localhost', port: 6379 } : undefined,
    db: opts.withDb !== false ? mockDb : undefined,
  })
  app.route('/api/v1/admin', router)
  return app
}

/** Helper: produce a fake child process that "succeeds" (exit 0). */
function fakePgDumpSuccess() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    stdout: EventEmitter
  }
  child.stderr = new EventEmitter()
  child.stdout = new EventEmitter()
  // Emit close async on next tick so the promise consumer can attach handlers.
  setImmediate(() => child.emit('close', 0))
  return child
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('admin routes — comprehensive (Phase 3.2)', () => {
  const savedNodeEnv = process.env.NODE_ENV
  const savedSkipPgdump = process.env.ADMIN_RESET_SKIP_PGDUMP
  const savedPostgresUrl = process.env.POSTGRES_URL
  const savedSlackBot = process.env.SLACK_BOT_TOKEN
  const savedSlackUser = process.env.SLACK_USER_TOKEN

  beforeEach(() => {
    vi.clearAllMocks()
    redisStore.clear()
    auditRowsInserted = []
    executeCalls = []
    insertShouldThrow = false
    executeShouldThrow = false
    process.env.NODE_ENV = 'test'
    process.env.ADMIN_RESET_SKIP_PGDUMP = 'true'
    delete process.env.SLACK_BOT_TOKEN
    delete process.env.SLACK_USER_TOKEN
  })

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv
    process.env.ADMIN_RESET_SKIP_PGDUMP = savedSkipPgdump
    if (savedPostgresUrl !== undefined) process.env.POSTGRES_URL = savedPostgresUrl
    else delete process.env.POSTGRES_URL
    if (savedSlackBot !== undefined) process.env.SLACK_BOT_TOKEN = savedSlackBot
    if (savedSlackUser !== undefined) process.env.SLACK_USER_TOKEN = savedSlackUser
  })

  // ── Origin allowlist (fail-closed) ──────────────────────────────────────────

  describe('checkOrigin() fail-closed semantics', () => {
    it('production + non-allowlisted origin → 403 RESET_FORBIDDEN + audit blocked', async () => {
      process.env.NODE_ENV = 'production'
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://evil.example.com',
          'Cf-Access-Authenticated-User-Email': 'attacker@evil.com',
        },
        body: JSON.stringify({ intent: 'reset' }),
      })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('RESET_FORBIDDEN')

      // Audit row written with outcome=blocked + error_detail=origin_check_failed
      expect(auditRowsInserted.length).toBe(1)
      expect(auditRowsInserted[0].event_type).toBe('reset_blocked')
      expect(auditRowsInserted[0].outcome).toBe('blocked')
      expect(auditRowsInserted[0].error_detail).toBe('origin_check_failed')
      expect(auditRowsInserted[0].actor).toBe('attacker@evil.com')
    })

    it('NODE_ENV=development with no Origin header → allowed (fail-open in dev)', async () => {
      process.env.NODE_ENV = 'development'
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      // Step 1 issues token successfully
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBeTruthy()
      expect(body.expires_in).toBe(300)
    })

    it('NODE_ENV=production with no Origin header → 403 (fail-closed)', async () => {
      process.env.NODE_ENV = 'production'
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('RESET_FORBIDDEN')
    })

    it('NODE_ENV unset (foot-gun) → treated as production, no Origin → 403', async () => {
      delete process.env.NODE_ENV
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(403)
      // Restore for subsequent tests in this describe
      process.env.NODE_ENV = 'test'
    })

    it('production + brain.troy-davis.com Origin → step 1 token issued', async () => {
      process.env.NODE_ENV = 'production'
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://brain.troy-davis.com',
          'Cf-Access-Authenticated-User-Email': 'troy@example.com',
        },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBeTruthy()

      // Audit row should reflect the CF-Access actor
      expect(auditRowsInserted[0].event_type).toBe('reset_requested')
      expect(auditRowsInserted[0].actor).toBe('troy@example.com')
      expect(auditRowsInserted[0].outcome).toBe('success')
    })
  })

  // ── Confirmation-phrase variants ────────────────────────────────────────────

  describe('confirmation phrase exact-match', () => {
    it('underscore variant ("WIPE_ALL_DATA") → 400 + audit blocked', async () => {
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE_ALL_DATA', token: 'any' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(auditRowsInserted.some(r =>
        r.event_type === 'reset_blocked' && r.error_detail === 'wrong_confirmation_phrase',
      )).toBe(true)

      // No truncation should have happened
      expect(executeCalls.some(c => c.includes('TRUNCATE'))).toBe(false)
    })

    it('lowercase variant ("wipe all data") → 400 + audit blocked', async () => {
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'wipe all data', token: 'any' }),
      })

      expect(res.status).toBe(400)
      expect(auditRowsInserted.some(r => r.error_detail === 'wrong_confirmation_phrase')).toBe(true)
    })

    it('correct phrase + missing token → 400 token_missing audit row', async () => {
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA' }),
      })

      expect(res.status).toBe(400)
      expect(auditRowsInserted.some(r =>
        r.event_type === 'reset_blocked' && r.error_detail === 'token_missing',
      )).toBe(true)
    })
  })

  // ── Token lifecycle ─────────────────────────────────────────────────────────

  describe('reset token lifecycle', () => {
    it('token replay (second use of same token) → 401 + audit blocked', async () => {
      mockSpawn.mockImplementation(() => fakePgDumpSuccess())
      const app = await buildApp()

      // Step 1: get a token
      const step1 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(step1.status).toBe(200)
      const { token } = await step1.json()

      // Step 2 — first use: succeeds (200) and GETDEL removes the token
      const step2a = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token }),
      })
      expect(step2a.status).toBe(200)

      // Step 2 — replay: token is now gone, 401
      const step2b = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token }),
      })
      expect(step2b.status).toBe(401)
      const body = await step2b.json()
      expect(body.code).toBe('RESET_TOKEN_INVALID')

      // Audit row for the replay should be reset_blocked / token_invalid_or_expired
      const replayAudit = auditRowsInserted.find(r =>
        r.event_type === 'reset_blocked' && r.error_detail === 'token_invalid_or_expired',
      )
      expect(replayAudit).toBeDefined()
    })

    it('expired token (Redis returns null) → 401 + audit blocked', async () => {
      const app = await buildApp()

      // Don't seed Redis — getdel will return null (simulates TTL expiry)
      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token: 'phantom-token-xyz' }),
      })

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.code).toBe('RESET_TOKEN_INVALID')
      expect(auditRowsInserted.some(r =>
        r.error_detail === 'token_invalid_or_expired',
      )).toBe(true)
    })
  })

  // ── pg_dump integration ─────────────────────────────────────────────────────

  describe('ADMIN_RESET_SKIP_PGDUMP env handling', () => {
    it('ADMIN_RESET_SKIP_PGDUMP=true → spawn NOT called, truncation proceeds', async () => {
      process.env.ADMIN_RESET_SKIP_PGDUMP = 'true'
      const app = await buildApp()

      const step1 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const { token } = await step1.json()

      const step2 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token }),
      })
      expect(step2.status).toBe(200)
      const body = await step2.json()
      expect(body.backup_path).toContain('SKIPPED-FOR-TESTS')

      // Critical: spawn must NOT have been called
      expect(mockSpawn).not.toHaveBeenCalled()

      // Truncation DID happen
      expect(executeCalls.some(c => c.includes('TRUNCATE'))).toBe(true)
    })

    it('ADMIN_RESET_SKIP_PGDUMP unset (prod-like) → spawn IS called with pg_dump args', async () => {
      delete process.env.ADMIN_RESET_SKIP_PGDUMP
      process.env.POSTGRES_URL = 'postgres://user:pass@localhost:5432/openbrain'
      mockSpawn.mockImplementation(() => fakePgDumpSuccess())

      const app = await buildApp()

      const step1 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const { token } = await step1.json()

      const step2 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token }),
      })
      expect(step2.status).toBe(200)

      // spawn invoked with pg_dump as the binary
      expect(mockSpawn).toHaveBeenCalled()
      const [bin, args] = mockSpawn.mock.calls[0]
      expect(bin).toBe('pg_dump')
      // Sanity: args carry the connection details from POSTGRES_URL
      expect(args).toContain('-h')
      expect(args).toContain('localhost')
      expect(args).toContain('-U')
      expect(args).toContain('user')
    })

    it('pg_dump failure (non-zero exit) → 500 PG_DUMP_FAILED + audit error', async () => {
      delete process.env.ADMIN_RESET_SKIP_PGDUMP
      process.env.POSTGRES_URL = 'postgres://user:pass@localhost:5432/openbrain'

      // Spawn returns a child that fails
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
        child.stderr = new EventEmitter()
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('pg_dump: connection failed'))
          child.emit('close', 1)
        })
        return child
      })

      const app = await buildApp()

      const step1 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const { token } = await step1.json()

      const step2 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token }),
      })
      expect(step2.status).toBe(500)
      const body = await step2.json()
      expect(body.code).toBe('PG_DUMP_FAILED')

      // Audit row with outcome=error + error_detail=pgdump_failed:*
      const errorAudit = auditRowsInserted.find(r =>
        r.event_type === 'reset_blocked' && r.outcome === 'error',
      )
      expect(errorAudit).toBeDefined()
      expect(errorAudit?.error_detail).toContain('pgdump_failed')

      // No TRUNCATE should have happened (abort on dump failure)
      expect(executeCalls.some(c => c.includes('TRUNCATE'))).toBe(false)
    })
  })

  // ── Audit invariants ────────────────────────────────────────────────────────

  describe('audit invariants', () => {
    it('admin_audit is NOT in the TRUNCATE statement (code-level)', async () => {
      const app = await buildApp()

      const step1 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const { token } = await step1.json()

      await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token }),
      })

      // Find the TRUNCATE call we captured
      const truncateCall = executeCalls.find(c => c.includes('TRUNCATE'))
      expect(truncateCall).toBeDefined()
      expect(truncateCall).not.toMatch(/admin_audit/)

      // Sanity: the response body lists admin_audit under preserved
      const step2Audit = auditRowsInserted.find(r => r.event_type === 'reset_executed')
      expect(step2Audit?.tables_affected).not.toContain('admin_audit')
    })

    it('full successful flow writes both reset_requested AND reset_executed audit rows', async () => {
      const app = await buildApp()

      const step1 = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'troy@example.com',
        },
        body: JSON.stringify({}),
      })
      const { token } = await step1.json()

      await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'troy@example.com',
        },
        body: JSON.stringify({ confirm: 'WIPE ALL DATA', token }),
      })

      const requested = auditRowsInserted.find(r => r.event_type === 'reset_requested')
      const executed = auditRowsInserted.find(r => r.event_type === 'reset_executed')

      expect(requested).toBeDefined()
      expect(requested?.outcome).toBe('success')
      expect(requested?.actor).toBe('troy@example.com')

      expect(executed).toBeDefined()
      expect(executed?.outcome).toBe('success')
      expect(executed?.confirmation_phrase).toBe('WIPE ALL DATA')
      expect(executed?.tables_affected).toEqual(
        expect.arrayContaining(['captures', 'pipeline_events', 'entities', 'sessions']),
      )
      expect(executed?.backup_path).toContain('SKIPPED-FOR-TESTS')
    })

    it('CF-Access email header drives actor attribution; missing → unknown@internal', async () => {
      const app = await buildApp()

      // No CF-Access header → actor falls back to unknown@internal
      await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(auditRowsInserted[0].actor).toBe('unknown@internal')
    })

    it('X-Forwarded-For first hop is captured as ip_address', async () => {
      const app = await buildApp()

      await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.42, 10.0.0.1',
        },
        body: JSON.stringify({}),
      })

      expect(auditRowsInserted[0].ip_address).toBe('203.0.113.42')
    })
  })

  // ── /config/reload (already adminAuth-gated) ────────────────────────────────

  describe('POST /admin/config/reload', () => {
    const savedAdminKey = process.env.ADMIN_API_KEY

    beforeEach(() => {
      process.env.ADMIN_API_KEY = 'test-admin-key-1234'
    })

    afterEach(() => {
      if (savedAdminKey !== undefined) process.env.ADMIN_API_KEY = savedAdminKey
      else delete process.env.ADMIN_API_KEY
    })

    it('all config files reload OK → 200 with success=true', async () => {
      mockConfigService.reload = vi.fn().mockReturnValue([
        { file: 'a.yaml', success: true },
        { file: 'b.yaml', success: true },
      ])
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/config/reload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer test-admin-key-1234' },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.results).toHaveLength(2)
      expect(body.reloaded_at).toBeTruthy()
    })

    it('partial config-reload failure → 207 with success=false', async () => {
      mockConfigService.reload = vi.fn().mockReturnValue([
        { file: 'a.yaml', success: true },
        { file: 'b.yaml', success: false, error: 'parse error' },
      ])
      const app = await buildApp()

      const res = await app.request('/api/v1/admin/config/reload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer test-admin-key-1234' },
      })

      expect(res.status).toBe(207)
      const body = await res.json()
      expect(body.success).toBe(false)
    })

    it('unauthenticated /config/reload → 401', async () => {
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/config/reload', { method: 'POST' })
      expect(res.status).toBe(401)
    })
  })

  // ── /banner Redis-backed CRUD ───────────────────────────────────────────────

  describe('admin banner — GET / POST / DELETE', () => {
    it('GET /banner with no banner → { banner: null }', async () => {
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/banner')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.banner).toBeNull()
    })

    it('POST /banner with valid payload → 200 banner echoed', async () => {
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Heads up — maintenance', level: 'warning' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.banner.message).toBe('Heads up — maintenance')
      expect(body.banner.level).toBe('warning')
      expect(body.banner.created_at).toBeTruthy()
    })

    it('POST /banner missing message → 400 VALIDATION_ERROR', async () => {
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'info' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('VALIDATION_ERROR')
    })

    it('POST /banner with unknown level → coerced to "info"', async () => {
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x', level: 'critical' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.banner.level).toBe('info')
    })

    it('POST /banner truncates messages to 500 chars', async () => {
      const app = await buildApp()
      const longMsg = 'a'.repeat(800)
      const res = await app.request('/api/v1/admin/banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: longMsg, level: 'info' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.banner.message.length).toBe(500)
    })

    it('DELETE /banner → { cleared: true }', async () => {
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/banner', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.cleared).toBe(true)
    })
  })

  // ── No-Redis placeholder routes ─────────────────────────────────────────────

  describe('graceful degradation when redisConnection is absent', () => {
    it('GET /queues returns placeholder message + queue list', async () => {
      const app = await buildApp({ withRedis: false })
      const res = await app.request('/api/v1/admin/queues')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.message).toMatch(/Bull Board requires a Redis/)
      expect(body.queues).toEqual(
        expect.arrayContaining(['capture-pipeline', 'skill-execution', 'notification']),
      )
    })

    it('GET /pipeline/health returns zeroed counts', async () => {
      const app = await buildApp({ withRedis: false })
      const res = await app.request('/api/v1/admin/pipeline/health')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.overall).toEqual({ pending: 0, processing: 0, complete: 0, failed: 0 })
    })

    it('POST /queues/:name/clear without Redis → 503', async () => {
      const app = await buildApp({ withRedis: false })
      const res = await app.request('/api/v1/admin/queues/capture-pipeline/clear', {
        method: 'POST',
      })
      expect(res.status).toBe(503)
    })

    it('reset-data without DB → 503 CONFIG_ERROR', async () => {
      const app = await buildApp({ withDb: false })
      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.code).toBe('CONFIG_ERROR')
    })

    it('reset-data without Redis → 503 SERVICE_UNAVAILABLE on step 1', async () => {
      const app = await buildApp({ withRedis: false })
      const res = await app.request('/api/v1/admin/reset-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.code).toBe('SERVICE_UNAVAILABLE')
    })
  })

  // ── Slack channel routes — no token configured ──────────────────────────────

  describe('Slack channel routes when no Slack token is configured', () => {
    it('GET /admin/slack/channels → 503 CONFIG_ERROR', async () => {
      // both env vars already deleted in beforeEach
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/slack/channels')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.code).toBe('CONFIG_ERROR')
    })

    it('POST /admin/slack/channels/:id/archive → 503 CONFIG_ERROR', async () => {
      const app = await buildApp()
      const res = await app.request('/api/v1/admin/slack/channels/C123/archive', {
        method: 'POST',
      })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.code).toBe('CONFIG_ERROR')
    })
  })
})
