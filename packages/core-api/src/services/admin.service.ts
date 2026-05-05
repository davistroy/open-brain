/**
 * AdminService — data + side-effect operations for the /admin/reset-data endpoint.
 *
 * All presentational/auth-layer logic (origin allowlist, confirmation phrase,
 * rate limiting, CF-Access actor parsing) remains in routes/admin.ts.
 * This service owns pure data ops:
 *
 *   - writeAuditRow()     — INSERT into admin_audit
 *   - runPreWipeDump()    — invoke pg_dump (via injected spawnPgDump) before wipe
 *   - truncateUserData()  — TRUNCATE user-data tables (admin_audit excluded — invariant)
 *   - issueResetToken()   — generate + store the 5-min single-use token in Redis (step 1)
 *   - consumeResetToken() — GETDEL atomic consume in Redis (step 2)
 *
 * Dependencies are constructor-injected so tests can stub them without module-level
 * vi.mock() overrides:
 *   - db          — Drizzle Database instance (INSERT / TRUNCATE)
 *   - redis       — single shared ioredis client (replaces the prior resetRedis + bannerRedis
 *                   duplication in admin.ts — closes A115)
 *   - spawnPgDump — abstraction over child_process.spawn so tests stub it cleanly.
 *                   Receives backupDir as its sole argument and returns Promise<string> (path).
 *                   The ADMIN_RESET_SKIP_PGDUMP env escape hatch is handled inside the
 *                   DEFAULT_SPAWN_PG_DUMP implementation exported below.
 */
import { sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { Database } from '@open-brain/shared'
import { admin_audit, logger } from '@open-brain/shared'
import type { Redis } from 'ioredis'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditEventType = 'reset_requested' | 'reset_executed' | 'reset_blocked'
export type AuditOutcome = 'success' | 'blocked' | 'error'

export interface WriteAuditRowInput {
  event_type: AuditEventType
  actor: string
  confirmation_phrase?: string
  tables_affected?: string[]
  outcome: AuditOutcome
  error_detail?: string
  backup_path?: string
  origin?: string
  ip_address?: string
}

/**
 * Function signature for the pg_dump abstraction injected into AdminService.
 * Receives the backup directory path; returns the path to the written dump file.
 * Throws on failure (non-zero pg_dump exit, missing POSTGRES_URL, etc.).
 */
export type SpawnPgDumpFn = (backupDir: string) => Promise<string>

export interface AdminServiceOptions {
  db: Database
  /** Single shared Redis client. AdminService does NOT new-up its own. */
  redis: Redis
  /** Injected pg_dump abstraction. Defaults to DEFAULT_SPAWN_PG_DUMP if omitted. */
  spawnPgDump?: SpawnPgDumpFn
}

// ── Default pg_dump implementation ────────────────────────────────────────────

/**
 * Default spawnPgDump implementation used in production.
 *
 * Handles the ADMIN_RESET_SKIP_PGDUMP=true escape hatch (set in tests via env).
 * Reads POSTGRES_URL from the environment. Spawns pg_dump with plain-text format,
 * no-owner, no-privileges, to <backupDir>/<ISO_timestamp>.sql.
 *
 * Tests that need to stub spawn should inject a custom SpawnPgDumpFn instead.
 */
export const DEFAULT_SPAWN_PG_DUMP: SpawnPgDumpFn = (backupDir: string): Promise<string> => {
  if (process.env.ADMIN_RESET_SKIP_PGDUMP === 'true') {
    return Promise.resolve(`${backupDir}/SKIPPED-FOR-TESTS`)
  }

  const pgUrl = process.env.POSTGRES_URL
  if (!pgUrl) return Promise.reject(new Error('POSTGRES_URL not set'))

  const url = new URL(pgUrl)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = `${backupDir}/${timestamp}.sql`
  mkdirSync(backupDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const proc = spawn('pg_dump', [
      '-h', url.hostname,
      '-p', url.port || '5432',
      '-U', url.username,
      '-d', url.pathname.slice(1),
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '-f', outPath,
    ], {
      env: { ...process.env, PGPASSWORD: url.password },
      timeout: 120_000,
    })
    const stderr: Buffer[] = []
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    proc.on('close', (code) => {
      if (code === 0) resolve(outPath)
      else reject(new Error(`pg_dump exit ${code}: ${Buffer.concat(stderr).toString()}`))
    })
    proc.on('error', reject)
  })
}

// ── Tables wiped on reset — MUST NOT include admin_audit ─────────────────────
//
// This list is also asserted at the route level: GET /reset-data step 2 returns
// { preserved: [..., 'admin_audit'] } and admin_audit is excluded from the TRUNCATE.
// Do NOT add admin_audit to this list. The code-level test in
// admin-reset-two-step.test.ts reads this file to assert that invariant.
export const TRUNCATE_TABLES = [
  'skills_log',
  'ai_audit_log',
  'session_messages',
  'bets',
  'sessions',
  'entity_links',
  'entity_relationships',
  'entities',
  'pipeline_events',
  'captures',
] as const

export type TruncateTable = typeof TRUNCATE_TABLES[number]

// ── AdminService class ────────────────────────────────────────────────────────

export class AdminService {
  private readonly db: Database
  private readonly redis: Redis
  private readonly spawnPgDump: SpawnPgDumpFn

  constructor({ db, redis, spawnPgDump }: AdminServiceOptions) {
    this.db = db
    this.redis = redis
    this.spawnPgDump = spawnPgDump ?? DEFAULT_SPAWN_PG_DUMP
  }

  /**
   * INSERT a row into admin_audit.
   * Returns the generated UUID of the new row.
   */
  async writeAuditRow(input: WriteAuditRowInput): Promise<string> {
    const [row] = await this.db
      .insert(admin_audit)
      .values(input)
      .returning({ id: admin_audit.id })
    return row.id
  }

  /**
   * Invoke pg_dump before a wipe. Returns the path to the written dump file.
   * Throws on failure — caller (route) should catch and log before returning 500.
   */
  async runPreWipeDump(backupDir: string): Promise<string> {
    return this.spawnPgDump(backupDir)
  }

  /**
   * TRUNCATE user-data tables.
   *
   * INVARIANT: admin_audit is intentionally excluded — it is the audit trail for
   * this very operation and must survive the wipe. The list is defined in
   * TRUNCATE_TABLES at the top of this file; the code-level test asserts its
   * absence by reading this source file.
   *
   * Returns the list of tables that were cleared (for the response body).
   */
  async truncateUserData(): Promise<string[]> {
    // Tables ordered to avoid FK constraint errors; CASCADE handles any remainder.
    // Triggers are intentionally preserved (user configuration, not test data).
    // __drizzle_migrations is a system table and is never touched.
    // admin_audit is intentionally EXCLUDED from this list — it is the audit trail
    // for this operation and must survive the wipe.
    await this.db.execute(sql`
      TRUNCATE
        skills_log,
        ai_audit_log,
        session_messages,
        bets,
        sessions,
        entity_links,
        entity_relationships,
        entities,
        pipeline_events,
        captures
      CASCADE
    `)

    return [
      'captures', 'pipeline_events', 'entities', 'entity_links',
      'entity_relationships', 'sessions', 'session_messages',
      'bets', 'skills_log', 'ai_audit_log',
    ]
  }

  /**
   * Issue a single-use reset token. Step 1 of the two-step reset flow.
   * Stores { actor, created_at } in Redis with a 5-minute TTL.
   * Returns the raw token string (base64url-encoded random bytes).
   */
  async issueResetToken(actor: string): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    await this.redis.set(
      `admin:reset-token:${token}`,
      JSON.stringify({ actor, created_at: new Date().toISOString() }),
      'EX',
      300,
    )
    logger.info({ actor }, '[AdminService] Reset token issued')
    return token
  }

  /**
   * Consume a reset token. Step 2 of the two-step reset flow.
   * Uses GETDEL for atomic single-use semantics — returns the stored payload
   * if the token exists and has not expired, or null if missing / already used.
   *
   * The caller is responsible for treating null as an invalid/expired token
   * and returning 401.
   */
  async consumeResetToken(token: string): Promise<string | null> {
    return this.redis.getdel(`admin:reset-token:${token}`)
  }
}
