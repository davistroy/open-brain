/**
 * Integration test setup — connects to real Postgres+pgvector and initializes schema.
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
import type { Hono } from 'hono'
import { createDb, type Database, type DbConnection, ConfigService } from '@open-brain/shared'
import { createApp } from '../../app.js'
import { CaptureService } from '../../services/capture.js'
import { SearchService } from '../../services/search.js'
import { EntityService } from '../../services/entity.js'
import { EntityResolutionService } from '../../services/entity-resolution.js'
import { BetService } from '../../services/bet.js'
import { SessionService } from '../../services/session.js'
import { TriggerService } from '../../services/trigger.js'

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Connection defaults (match docker-compose.test.yml)
// ---------------------------------------------------------------------------

const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ??
  'postgresql://openbrain_test:test_password@localhost:5433/openbrain_test'

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6381'

// ---------------------------------------------------------------------------
// Schema initialization — applies init-schema.sql (full DDL + functions)
// ---------------------------------------------------------------------------

/** Resolve path to scripts/init-schema.sql from repo root. */
function resolveInitSchemaPath(): string {
  // Walk up from packages/core-api/src/__tests__/integration/ to repo root
  return join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'init-schema.sql')
}

/** Resolve path to config/ from repo root. */
function resolveConfigDir(): string {
  return join(__dirname, '..', '..', '..', '..', '..', 'config')
}

/**
 * Apply the full schema DDL to the test database.
 * Uses a raw pg Pool (not Drizzle) so we can execute multi-statement SQL.
 */
async function applySchema(connectionString: string): Promise<void> {
  const schemaPath = resolveInitSchemaPath()
  const schemaSql = readFileSync(schemaPath, 'utf8')

  const pool = new Pool({ connectionString })
  try {
    await pool.query(schemaSql)
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
 * Get the current test database connection.
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

// ---------------------------------------------------------------------------
// Test App factory — wires real services against the test database
// ---------------------------------------------------------------------------

export interface TestAppContext {
  app: Hono
  db: Database
  captureService: CaptureService
  searchService: SearchService
  entityService: EntityService
  betService: BetService
  sessionService: SessionService
  triggerService: TriggerService
}

/**
 * Create a fully wired Hono app backed by the real test database.
 *
 * Embedding-dependent features use a stub EmbeddingService that returns
 * zero vectors (LiteLLM won't be available in test/CI).
 *
 * ConfigService loads from the real config/ directory.
 */
export function getTestApp(): TestAppContext {
  const db = getTestDb()

  // ConfigService — load from real config files
  const configDir = resolveConfigDir()
  const configService = new ConfigService(configDir)
  configService.load()

  // Stub embedding service — returns zero vectors for integration tests
  const stubEmbeddingService = {
    embed: async (_text: string): Promise<number[]> => new Array(768).fill(0),
    embedBatch: async (texts: string[]): Promise<number[][]> =>
      texts.map(() => new Array(768).fill(0)),
  }

  // Wire services with real DB
  const captureService = new CaptureService(db)
  const searchService = new SearchService(db, stubEmbeddingService as any)
  const entityResolutionService = new EntityResolutionService(db)
  const entityService = new EntityService(db, entityResolutionService)
  const betService = new BetService(db)
  const triggerService = new TriggerService(db, stubEmbeddingService as any)
  const sessionService = new SessionService(db, captureService)

  const app = createApp({
    configService,
    captureService,
    searchService,
    db,
    triggerService,
    entityService,
    betService,
    sessionService,
  })

  return {
    app,
    db,
    captureService,
    searchService,
    entityService,
    betService,
    sessionService,
    triggerService,
  }
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export { TEST_POSTGRES_URL }
