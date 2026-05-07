/**
 * Workers integration test setup — connects to real Postgres+pgvector and Redis.
 *
 * Expects docker-compose.test.yml services to be running:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Environment variables (with defaults matching docker-compose.test.yml):
 *   TEST_POSTGRES_URL  — default: postgresql://openbrain_test:test_password@localhost:5433/openbrain_test
 *   TEST_REDIS_URL     — default: redis://localhost:6381
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { createDb, type Database, type DbConnection } from '@open-brain/shared'
import type { ConnectionOptions } from 'bullmq'

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Connection defaults (match docker-compose.test.yml)
// ---------------------------------------------------------------------------

export const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  'postgresql://openbrain_test:test_password@localhost:5433/openbrain_test'

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6381'

// ---------------------------------------------------------------------------
// Redis connection helper
// ---------------------------------------------------------------------------

export function parseRedisUrl(url: string): ConnectionOptions {
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    ...(parsed.password ? { password: parsed.password } : {}),
  }
}

export const redisConnection = parseRedisUrl(TEST_REDIS_URL)

// ---------------------------------------------------------------------------
// Schema initialization — applies init-schema.sql (full DDL + functions)
// ---------------------------------------------------------------------------

/** Resolve path to scripts/init-schema.sql from repo root. */
function resolveInitSchemaPath(): string {
  // Walk up from packages/workers/src/__tests__/integration/ to repo root
  return join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'init-schema.sql')
}

/** Resolve a drizzle migration SQL path relative to repo root. */
function resolveDrizzleMigrationPath(filename: string): string {
  return join(__dirname, '..', '..', '..', '..', '..', 'packages', 'shared', 'drizzle', filename)
}

/**
 * Apply the full schema DDL to the test database.
 * Uses a raw pg Pool (not Drizzle) so we can execute multi-statement SQL.
 *
 * init-schema.sql is the primary source (all tables up to 0031), but
 * capture_associations is absent from it (tracked as A125). Apply migration
 * 0011 as a supplement so access-stats-e2e tests can use the table.
 * Remove this supplement once A125 is resolved and init-schema.sql is patched.
 */
async function applySchema(connectionString: string): Promise<void> {
  const schemaPath = resolveInitSchemaPath()
  const schemaSql = readFileSync(schemaPath, 'utf8')

  // A125 supplement: capture_associations (migration 0011) absent from init-schema.sql
  const captureAssocSql = readFileSync(resolveDrizzleMigrationPath('0011_capture_associations.sql'), 'utf8')

  const pool = new Pool({ connectionString })
  try {
    await pool.query(schemaSql)
    await pool.query(captureAssocSql)
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let dbConnection: DbConnection | null = null

/**
 * Initialize the test database: connect, apply full schema.
 * Call this in a `beforeAll` hook at the suite level.
 */
export async function initTestDatabase(): Promise<DbConnection> {
  await applySchema(TEST_POSTGRES_URL)
  dbConnection = createDb(TEST_POSTGRES_URL)
  return dbConnection
}

/**
 * Get the current test database instance (Drizzle).
 * Throws if `initTestDatabase()` hasn't been called.
 */
export function getTestDb(): Database {
  if (!dbConnection) {
    throw new Error('Test database not initialized. Call initTestDatabase() first.')
  }
  return dbConnection.db
}

/**
 * Get the raw pg Pool for direct SQL operations (cleanup, etc.).
 */
export function getTestPool(): Pool {
  if (!dbConnection) {
    throw new Error('Test database not initialized. Call initTestDatabase() first.')
  }
  return dbConnection.pool
}

/**
 * Tear down the test database connection.
 * Call this in an `afterAll` hook at the suite level.
 */
export async function teardownTestDatabase(): Promise<void> {
  if (dbConnection) {
    await dbConnection.pool.end()
    dbConnection = null
  }
}
