/**
 * Integration test smoke test — validates test infrastructure is working.
 *
 * This test verifies:
 * 1. Test DB connects and schema is applied (tables + SQL functions exist)
 * 2. getTestApp() returns a working Hono app
 * 3. Helper utilities create valid test data
 * 4. cleanDatabase() properly resets state between tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  initTestDatabase,
  teardownTestDatabase,
  getTestDb,
  getTestApp,
  type TestAppContext,
} from './setup.js'
import {
  cleanDatabase,
  createTestCapture,
  createTestEntity,
  linkEntityToCapture,
  createTestBet,
  createTestSession,
  seedTestData,
  testGet,
  testPost,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

let ctx: TestAppContext

beforeAll(async () => {
  await initTestDatabase()
  ctx = getTestApp()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await cleanDatabase()
})

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

describe('Test Infrastructure', () => {
  it('connects to the test database', async () => {
    const db = getTestDb()
    expect(db).toBeDefined()
  })

  it('has the captures table', async () => {
    const capture = await createTestCapture({ content: 'Schema test capture' })
    expect(capture.id).toBeDefined()
    expect(capture.content).toBe('Schema test capture')
    expect(capture.pipeline_status).toBe('pending')
  })

  it('has the entities table', async () => {
    const entity = await createTestEntity({ name: 'TestEntity', entity_type: 'concept' })
    expect(entity.id).toBeDefined()
    expect(entity.name).toBe('TestEntity')
  })

  it('has the entity_links table', async () => {
    const capture = await createTestCapture()
    const entity = await createTestEntity()
    const link = await linkEntityToCapture(entity.id as string, capture.id as string)
    expect(link.id).toBeDefined()
    expect(link.entity_id).toBe(entity.id)
    expect(link.capture_id).toBe(capture.id)
  })

  it('has the bets table', async () => {
    const bet = await createTestBet({ statement: 'Test prediction', confidence: 0.8 })
    expect(bet.id).toBeDefined()
    expect(bet.statement).toBe('Test prediction')
    expect(bet.confidence).toBeCloseTo(0.8)
  })

  it('has the sessions table', async () => {
    const session = await createTestSession({ session_type: 'governance' })
    expect(session.id).toBeDefined()
    expect(session.session_type).toBe('governance')
    expect(session.status).toBe('active')
  })

  it('has SQL functions (hybrid_search exists)', async () => {
    // Verify the function exists by querying pg_proc
    const pool = (await import('./setup.js')).getTestPool()
    const result = await pool.query(
      "SELECT proname FROM pg_proc WHERE proname = 'hybrid_search'",
    )
    expect(result.rows).toHaveLength(1)
  })

  it('has SQL functions (fts_only_search exists)', async () => {
    const pool = (await import('./setup.js')).getTestPool()
    const result = await pool.query(
      "SELECT proname FROM pg_proc WHERE proname = 'fts_only_search'",
    )
    expect(result.rows).toHaveLength(1)
  })

  it('has SQL functions (update_capture_embedding exists)', async () => {
    const pool = (await import('./setup.js')).getTestPool()
    const result = await pool.query(
      "SELECT proname FROM pg_proc WHERE proname = 'update_capture_embedding'",
    )
    expect(result.rows).toHaveLength(1)
  })

  it('has pgvector extension enabled', async () => {
    const pool = (await import('./setup.js')).getTestPool()
    const result = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    )
    expect(result.rows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// cleanDatabase verification
// ---------------------------------------------------------------------------

describe('cleanDatabase', () => {
  it('removes all data between tests', async () => {
    // Create data
    await createTestCapture()
    await createTestCapture()
    await createTestEntity()

    // Verify data exists
    const pool = (await import('./setup.js')).getTestPool()
    const before = await pool.query('SELECT count(*) FROM captures')
    expect(Number(before.rows[0].count)).toBe(2)

    // Clean
    await cleanDatabase()

    // Verify clean
    const after = await pool.query('SELECT count(*) FROM captures')
    expect(Number(after.rows[0].count)).toBe(0)

    const entitiesAfter = await pool.query('SELECT count(*) FROM entities')
    expect(Number(entitiesAfter.rows[0].count)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// seedTestData verification
// ---------------------------------------------------------------------------

describe('seedTestData', () => {
  it('creates a representative dataset', async () => {
    const data = await seedTestData()

    expect(data.captures).toHaveLength(8)
    expect(data.entities).toHaveLength(3)
    expect(data.links).toHaveLength(3)

    // Verify brain views are diverse
    const views = new Set(data.captures.map((c) => c.brain_view))
    expect(views.size).toBeGreaterThanOrEqual(3)

    // Verify capture types are diverse
    const types = new Set(data.captures.map((c) => c.capture_type))
    expect(types.size).toBeGreaterThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// Test App verification
// ---------------------------------------------------------------------------

describe('getTestApp', () => {
  it('returns a working Hono app', () => {
    expect(ctx.app).toBeDefined()
    expect(ctx.captureService).toBeDefined()
    expect(ctx.searchService).toBeDefined()
    expect(ctx.entityService).toBeDefined()
    expect(ctx.betService).toBeDefined()
  })

  it('serves the health endpoint', async () => {
    const res = await testGet(ctx.app, '/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('serves the captures API', async () => {
    // Seed some data first
    await createTestCapture({ content: 'API test capture' })

    const res = await testGet(ctx.app, '/api/v1/captures?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].content).toBe('API test capture')
  })

  it('creates captures via POST', async () => {
    const res = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Created via API',
      capture_type: 'idea',
      brain_view: 'technical',
      source: 'api',
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.content).toBe('Created via API')
    expect(body.id).toBeDefined()
    expect(body.pipeline_status).toBe('pending')
  })
})
