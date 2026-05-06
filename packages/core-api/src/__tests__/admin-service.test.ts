/**
 * Unit tests for AdminService (Phase 5.1 — AdminService extraction).
 *
 * Tests the service methods in isolation with injected mock deps:
 *   - writeAuditRow()     — INSERT into admin_audit, returns row UUID
 *   - runPreWipeDump()    — delegates to injected spawnPgDump fn
 *   - truncateUserData()  — TRUNCATE user tables, excludes admin_audit
 *   - issueResetToken()   — randomBytes → Redis SET with 5-min TTL
 *   - consumeResetToken() — Redis GETDEL, returns null when expired
 *
 * ADMIN_RESET_SKIP_PGDUMP escape hatch is tested via DEFAULT_SPAWN_PG_DUMP
 * directly (env-level gate, no child process involved when set).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AdminService, DEFAULT_SPAWN_PG_DUMP, TRUNCATE_TABLES } from '../services/admin.service.js'
import type { WriteAuditRowInput } from '../services/admin.service.js'
import type { Database } from '@open-brain/shared'

// ── Mock DB ────────────────────────────────────────────────────────────────────

interface InsertedRow {
  event_type?: string
  outcome?: string
  error_detail?: string
  actor?: string
  confirmation_phrase?: string
  tables_affected?: string[]
  backup_path?: string
  origin?: string
  ip_address?: string
}

let insertedRows: InsertedRow[] = []
let executeCallTexts: string[] = []
let insertShouldThrow = false
let executeShouldThrow = false
let insertIdCounter = 0

function makeDb(): Database {
  return {
    insert: vi.fn().mockImplementation(() => {
      if (insertShouldThrow) throw new Error('db_insert_failed')
      return {
        values: vi.fn().mockImplementation((row: InsertedRow) => {
          insertedRows.push(row)
          return {
            returning: vi.fn().mockResolvedValue([{ id: `audit-id-${++insertIdCounter}` }]),
          }
        }),
      }
    }),
    execute: vi.fn().mockImplementation(async (q: unknown) => {
      if (executeShouldThrow) throw new Error('db_execute_failed')
      const text = (q as { queryChunks?: unknown[] }).queryChunks
        ? JSON.stringify((q as { queryChunks?: unknown[] }).queryChunks)
        : String(q)
      executeCallTexts.push(text)
      return undefined
    }),
  } as unknown as Database
}

// ── Mock Redis ─────────────────────────────────────────────────────────────────

const redisStore: Map<string, string> = new Map()
let getdelShouldReturnNull = false

function makeRedis() {
  return {
    set: vi.fn().mockImplementation(async (key: string, value: string) => {
      redisStore.set(key, value)
      return 'OK'
    }),
    getdel: vi.fn().mockImplementation(async (key: string) => {
      if (getdelShouldReturnNull) return null
      const val = redisStore.get(key) ?? null
      redisStore.delete(key)
      return val
    }),
    get: vi.fn().mockImplementation(async (key: string) => redisStore.get(key) ?? null),
    del: vi.fn().mockImplementation(async (key: string) => {
      redisStore.delete(key)
      return 1
    }),
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeService(opts?: { spawnPgDump?: (dir: string) => Promise<string> }) {
  return new AdminService({
    db: makeDb(),
    redis: makeRedis() as never,
    ...(opts?.spawnPgDump ? { spawnPgDump: opts.spawnPgDump } : {}),
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AdminService', () => {
  beforeEach(() => {
    insertedRows = []
    executeCallTexts = []
    insertShouldThrow = false
    executeShouldThrow = false
    getdelShouldReturnNull = false
    insertIdCounter = 0
    redisStore.clear()
    vi.clearAllMocks()
  })

  // ── writeAuditRow ─────────────────────────────────────────────────────────

  describe('writeAuditRow()', () => {
    it('inserts a row and returns the generated UUID', async () => {
      const svc = makeService()
      const input: WriteAuditRowInput = {
        event_type: 'reset_requested',
        actor: 'troy@example.com',
        outcome: 'success',
      }
      const id = await svc.writeAuditRow(input)
      expect(id).toBe('audit-id-1')
      expect(insertedRows).toHaveLength(1)
      expect(insertedRows[0].event_type).toBe('reset_requested')
      expect(insertedRows[0].actor).toBe('troy@example.com')
    })

    it('passes all optional fields to the db insert', async () => {
      const svc = makeService()
      const input: WriteAuditRowInput = {
        event_type: 'reset_blocked',
        actor: 'attacker@evil.com',
        outcome: 'blocked',
        error_detail: 'origin_check_failed',
        origin: 'https://evil.example.com',
        ip_address: '203.0.113.42',
        tables_affected: ['captures', 'entities'],
        backup_path: '/backup/pre-wipe/2026-01-01.sql',
        confirmation_phrase: 'WIPE ALL DATA',
      }
      await svc.writeAuditRow(input)
      const row = insertedRows[0]
      expect(row.error_detail).toBe('origin_check_failed')
      expect(row.origin).toBe('https://evil.example.com')
      expect(row.ip_address).toBe('203.0.113.42')
      expect(row.tables_affected).toEqual(['captures', 'entities'])
      expect(row.backup_path).toBe('/backup/pre-wipe/2026-01-01.sql')
      expect(row.confirmation_phrase).toBe('WIPE ALL DATA')
    })

    it('returns sequential IDs on multiple calls', async () => {
      const svc = makeService()
      const base: WriteAuditRowInput = { event_type: 'reset_requested', actor: 'x', outcome: 'success' }
      const id1 = await svc.writeAuditRow(base)
      const id2 = await svc.writeAuditRow(base)
      expect(id1).toBe('audit-id-1')
      expect(id2).toBe('audit-id-2')
    })
  })

  // ── runPreWipeDump ────────────────────────────────────────────────────────

  describe('runPreWipeDump()', () => {
    it('delegates to the injected spawnPgDump fn', async () => {
      const mockSpawn = vi.fn().mockResolvedValue('/backup/pre-wipe/2026-01-01.sql')
      const svc = makeService({ spawnPgDump: mockSpawn })
      const path = await svc.runPreWipeDump('/backup/pre-wipe')
      expect(mockSpawn).toHaveBeenCalledWith('/backup/pre-wipe')
      expect(path).toBe('/backup/pre-wipe/2026-01-01.sql')
    })

    it('propagates rejection from spawnPgDump', async () => {
      const mockSpawn = vi.fn().mockRejectedValue(new Error('pg_dump exit 1: connection refused'))
      const svc = makeService({ spawnPgDump: mockSpawn })
      await expect(svc.runPreWipeDump('/backup/pre-wipe'))
        .rejects.toThrow('pg_dump exit 1: connection refused')
    })
  })

  // ── truncateUserData ──────────────────────────────────────────────────────

  describe('truncateUserData()', () => {
    it('executes a TRUNCATE statement and returns the cleared table list', async () => {
      const svc = makeService()
      const cleared = await svc.truncateUserData()
      expect(executeCallTexts.some(t => t.includes('TRUNCATE'))).toBe(true)
      expect(cleared).toContain('captures')
      expect(cleared).toContain('pipeline_events')
      expect(cleared).toContain('entities')
      expect(cleared).toContain('sessions')
    })

    it('admin_audit is NOT in the TRUNCATE statement', async () => {
      const svc = makeService()
      await svc.truncateUserData()
      const truncateText = executeCallTexts.find(t => t.includes('TRUNCATE'))
      // The TRUNCATE SQL should not contain admin_audit
      expect(truncateText).not.toMatch(/admin_audit/)
    })

    it('admin_audit is NOT in the TRUNCATE_TABLES exported constant', () => {
      // Code-level invariant: any regression adding admin_audit to the list is caught here
      expect(TRUNCATE_TABLES).not.toContain('admin_audit')
    })

    it('TRUNCATE_TABLES does not include admin_audit (source-level read)', async () => {
      const { readFileSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      const __dirname = fileURLToPath(new URL('.', import.meta.url))
      const src = readFileSync(resolve(__dirname, '../services/admin.service.ts'), 'utf-8')
      // Match only the SQL TRUNCATE body (from TRUNCATE keyword to CASCADE).
      // The regex starts from TRUNCATE (not from `sql`` which may appear earlier in outPath template literals)
      // and anchors to the CASCADE keyword that closes the statement.
      // Comments between the function name and the sql`` call may mention admin_audit
      // (they explain the exclusion) — this test verifies the actual statement, not the comments.
      const truncateMatch = src.match(/TRUNCATE\s*\n\s+\w[\s\S]+?CASCADE/)
      expect(truncateMatch).not.toBeNull()
      if (truncateMatch) {
        // The table list itself must not contain admin_audit
        expect(truncateMatch[0]).not.toMatch(/admin_audit/)
      }
    })

    it('propagates db.execute errors', async () => {
      executeShouldThrow = true
      const svc = makeService()
      await expect(svc.truncateUserData()).rejects.toThrow('db_execute_failed')
    })
  })

  // ── issueResetToken ───────────────────────────────────────────────────────

  describe('issueResetToken()', () => {
    it('returns a non-empty token string', async () => {
      const svc = makeService()
      const token = await svc.issueResetToken('troy@example.com')
      expect(typeof token).toBe('string')
      expect(token.length).toBeGreaterThan(10)
    })

    it('stores the token in Redis with admin:reset-token: prefix', async () => {
      const svc = makeService()
      const token = await svc.issueResetToken('troy@example.com')
      const stored = redisStore.get(`admin:reset-token:${token}`)
      expect(stored).toBeTruthy()
      const parsed = JSON.parse(stored!)
      expect(parsed.actor).toBe('troy@example.com')
      expect(parsed.created_at).toBeTruthy()
    })

    it('generates unique tokens on sequential calls', async () => {
      const svc = makeService()
      const t1 = await svc.issueResetToken('user@example.com')
      const t2 = await svc.issueResetToken('user@example.com')
      expect(t1).not.toBe(t2)
    })
  })

  // ── consumeResetToken ─────────────────────────────────────────────────────

  describe('consumeResetToken()', () => {
    it('returns stored payload and removes the key (atomic single-use)', async () => {
      const svc = makeService()
      const token = await svc.issueResetToken('troy@example.com')
      // Confirm it's in the store
      expect(redisStore.has(`admin:reset-token:${token}`)).toBe(true)
      // Consume
      const result = await svc.consumeResetToken(token)
      expect(result).toBeTruthy()
      const parsed = JSON.parse(result!)
      expect(parsed.actor).toBe('troy@example.com')
      // Key should be gone after GETDEL
      expect(redisStore.has(`admin:reset-token:${token}`)).toBe(false)
    })

    it('returns null for a token that was already consumed (replay)', async () => {
      const svc = makeService()
      const token = await svc.issueResetToken('troy@example.com')
      // First consume
      await svc.consumeResetToken(token)
      // Second consume — token is gone, GETDEL returns null
      const result = await svc.consumeResetToken(token)
      expect(result).toBeNull()
    })

    it('returns null for a token that was never issued (expired or phantom)', async () => {
      getdelShouldReturnNull = true
      const svc = makeService()
      const result = await svc.consumeResetToken('phantom-token-xyz')
      expect(result).toBeNull()
    })
  })

  // ── DEFAULT_SPAWN_PG_DUMP escape hatch ────────────────────────────────────

  describe('DEFAULT_SPAWN_PG_DUMP (escape hatch)', () => {
    const savedSkipPgdump = process.env.ADMIN_RESET_SKIP_PGDUMP
    const savedPostgresUrl = process.env.POSTGRES_URL

    beforeEach(() => {
      process.env.ADMIN_RESET_SKIP_PGDUMP = 'true'
    })

    afterEach(() => {
      if (savedSkipPgdump !== undefined) process.env.ADMIN_RESET_SKIP_PGDUMP = savedSkipPgdump
      else delete process.env.ADMIN_RESET_SKIP_PGDUMP
      if (savedPostgresUrl !== undefined) process.env.POSTGRES_URL = savedPostgresUrl
      else delete process.env.POSTGRES_URL
    })

    it('ADMIN_RESET_SKIP_PGDUMP=true → returns SKIPPED-FOR-TESTS path without spawning', async () => {
      const path = await DEFAULT_SPAWN_PG_DUMP('/backup/pre-wipe')
      expect(path).toBe('/backup/pre-wipe/SKIPPED-FOR-TESTS')
    })

    it('ADMIN_RESET_SKIP_PGDUMP unset + no POSTGRES_URL → rejects with error', async () => {
      delete process.env.ADMIN_RESET_SKIP_PGDUMP
      delete process.env.POSTGRES_URL
      await expect(DEFAULT_SPAWN_PG_DUMP('/backup/pre-wipe'))
        .rejects.toThrow('POSTGRES_URL not set')
    })
  })
})
