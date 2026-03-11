/**
 * Integration tests — Entities API
 *
 * Exercises entity endpoints against a real Postgres database:
 *   GET  /api/v1/entities           — list entities with filters, sort, pagination
 *   GET  /api/v1/entities?name=...  — lookup by name
 *   GET  /api/v1/entities/:id       — entity detail with linked captures
 *   POST /api/v1/entities/:id/merge — merge two entities
 *   POST /api/v1/entities/:id/split — split alias into new entity
 *
 * Also verifies:
 *   - Entity count accuracy (regression: total_entities was 0 in stats)
 *   - mention_count is derived correctly from entity_links count
 *   - Entity-capture relationships are reflected in detail views
 *   - Merge and split operations maintain referential integrity
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  initTestDatabase,
  teardownTestDatabase,
  getTestApp,
  type TestAppContext,
} from './setup.js'
import {
  cleanDatabase,
  createTestCapture,
  createTestEntity,
  linkEntityToCapture,
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
// GET /api/v1/entities — List
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities', () => {
  it('returns empty list when no entities exist', async () => {
    const res = await testGet(ctx.app, '/api/v1/entities?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
  })

  it('returns entities with correct fields', async () => {
    await createTestEntity({ name: 'TypeScript', entity_type: 'tool' })
    await createTestEntity({ name: 'React', entity_type: 'tool' })

    const res = await testGet(ctx.app, '/api/v1/entities?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(2)

    // Verify each item has expected fields
    for (const item of body.items) {
      expect(item.id).toBeDefined()
      expect(item.name).toBeDefined()
      expect(item.entity_type).toBe('tool')
      expect(item.canonical_name).toBeDefined()
      expect(item.aliases).toBeDefined()
      expect(typeof item.mention_count).toBe('number')
    }
  })

  it('filters by type_filter', async () => {
    await createTestEntity({ name: 'PostgreSQL', entity_type: 'tool' })
    await createTestEntity({ name: 'Troy', entity_type: 'person' })
    await createTestEntity({ name: 'Microservices', entity_type: 'concept' })

    const res = await testGet(ctx.app, '/api/v1/entities?type_filter=tool&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].name).toBe('PostgreSQL')
    expect(body.total).toBe(1)
  })

  it('sorts by name', async () => {
    await createTestEntity({ name: 'Zebra', entity_type: 'concept' })
    await createTestEntity({ name: 'Alpha', entity_type: 'concept' })
    await createTestEntity({ name: 'Middle', entity_type: 'concept' })

    const res = await testGet(ctx.app, '/api/v1/entities?sort_by=name&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].name).toBe('Alpha')
    expect(body.items[1].name).toBe('Middle')
    expect(body.items[2].name).toBe('Zebra')
  })

  it('sorts by mention_count descending', async () => {
    const entityA = await createTestEntity({ name: 'PopularEntity' })
    const entityB = await createTestEntity({ name: 'UnpopularEntity' })

    // Create captures and link to entities
    const cap1 = await createTestCapture({ content: 'Mention 1' })
    const cap2 = await createTestCapture({ content: 'Mention 2' })
    const cap3 = await createTestCapture({ content: 'Mention 3' })

    // PopularEntity has 3 mentions, UnpopularEntity has 1
    await linkEntityToCapture(entityA.id as string, cap1.id as string)
    await linkEntityToCapture(entityA.id as string, cap2.id as string)
    await linkEntityToCapture(entityA.id as string, cap3.id as string)
    await linkEntityToCapture(entityB.id as string, cap1.id as string)

    const res = await testGet(ctx.app, '/api/v1/entities?sort_by=mention_count&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].name).toBe('PopularEntity')
    expect(body.items[0].mention_count).toBe(3)
    expect(body.items[1].name).toBe('UnpopularEntity')
    expect(body.items[1].mention_count).toBe(1)
  })

  it('supports pagination', async () => {
    for (let i = 0; i < 15; i++) {
      await createTestEntity({ name: `Entity-${i.toString().padStart(2, '0')}` })
    }

    const page1 = await testGet(ctx.app, '/api/v1/entities?sort_by=name&limit=5&offset=0')
    const body1 = await page1.json()
    expect(body1.items).toHaveLength(5)
    expect(body1.total).toBe(15)
    expect(body1.limit).toBe(5)
    expect(body1.offset).toBe(0)

    const page2 = await testGet(ctx.app, '/api/v1/entities?sort_by=name&limit=5&offset=5')
    const body2 = await page2.json()
    expect(body2.items).toHaveLength(5)
    expect(body2.total).toBe(15)

    // No overlap
    const ids1 = new Set(body1.items.map((e: any) => e.id))
    for (const item of body2.items) {
      expect(ids1.has(item.id)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/entities?name=... — Lookup by name
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities?name=...', () => {
  it('finds entity by exact name (case-insensitive)', async () => {
    await createTestEntity({ name: 'PostgreSQL', entity_type: 'tool' })

    const res = await testGet(ctx.app, '/api/v1/entities?name=postgresql')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entity).toBeDefined()
    expect(body.entity.name).toBe('PostgreSQL')
  })

  it('returns 404 for nonexistent entity name', async () => {
    const res = await testGet(ctx.app, '/api/v1/entities?name=NonexistentThing')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/entities/:id — Detail with linked captures
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities/:id', () => {
  it('returns entity detail with linked captures', async () => {
    const entity = await createTestEntity({ name: 'Hono Framework', entity_type: 'tool' })
    const cap1 = await createTestCapture({
      content: 'Using Hono for the API layer',
      capture_type: 'decision',
      brain_view: 'technical',
    })
    const cap2 = await createTestCapture({
      content: 'Hono performance benchmarks look great',
      capture_type: 'observation',
      brain_view: 'technical',
    })

    await linkEntityToCapture(entity.id as string, cap1.id as string, 'mentioned', 0.95)
    await linkEntityToCapture(entity.id as string, cap2.id as string, 'referenced', 0.85)

    const res = await testGet(ctx.app, `/api/v1/entities/${entity.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.name).toBe('Hono Framework')
    expect(body.entity_type).toBe('tool')
    expect(body.mention_count).toBe(2)
    expect(body.linked_captures).toHaveLength(2)

    // Verify linked capture fields
    for (const lc of body.linked_captures) {
      expect(lc.id).toBeDefined()
      expect(lc.content).toBeDefined()
      expect(lc.capture_type).toBeDefined()
      expect(lc.brain_view).toBe('technical')
      expect(lc.relationship).toBeDefined()
      expect(lc.confidence).toBeDefined()
    }
  })

  it('returns empty linked_captures for entity with no links', async () => {
    const entity = await createTestEntity({ name: 'Orphan Entity' })

    const res = await testGet(ctx.app, `/api/v1/entities/${entity.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('Orphan Entity')
    expect(body.linked_captures).toEqual([])
    expect(body.mention_count).toBe(0)
  })

  it('returns 404 for nonexistent entity ID', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await testGet(ctx.app, `/api/v1/entities/${fakeId}`)
    expect(res.status).toBe(404)
  })

  it('excludes soft-deleted captures from linked_captures', async () => {
    const entity = await createTestEntity({ name: 'LinkTest' })
    const cap1 = await createTestCapture({ content: 'Visible capture' })
    const cap2 = await createTestCapture({ content: 'Deleted capture', pipeline_status: 'deleted' })

    await linkEntityToCapture(entity.id as string, cap1.id as string)
    await linkEntityToCapture(entity.id as string, cap2.id as string)

    const res = await testGet(ctx.app, `/api/v1/entities/${entity.id}`)
    const body = await res.json()

    // Only non-deleted captures should appear
    expect(body.linked_captures).toHaveLength(1)
    expect(body.linked_captures[0].content).toBe('Visible capture')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/merge — Merge entities
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/merge', () => {
  it('merges source entity into target', async () => {
    const source = await createTestEntity({ name: 'JS', entity_type: 'tool', aliases: ['javascript'] })
    const target = await createTestEntity({ name: 'JavaScript', entity_type: 'tool' })

    // Link a capture to source
    const cap = await createTestCapture({ content: 'JS framework comparison' })
    await linkEntityToCapture(source.id as string, cap.id as string)

    const res = await testPost(ctx.app, `/api/v1/entities/${source.id}/merge`, {
      target_id: target.id,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source_id).toBe(source.id)
    expect(body.target_id).toBe(target.id)

    // Source should no longer exist
    const sourceRes = await testGet(ctx.app, `/api/v1/entities/${source.id}`)
    expect(sourceRes.status).toBe(404)

    // Target should have the merged capture link
    const targetRes = await testGet(ctx.app, `/api/v1/entities/${target.id}`)
    const targetBody = await targetRes.json()
    expect(targetBody.linked_captures).toHaveLength(1)
    expect(targetBody.linked_captures[0].content).toBe('JS framework comparison')

    // Target should have merged aliases (source name + source aliases)
    expect(targetBody.aliases).toContain('JS')
    expect(targetBody.aliases).toContain('javascript')
  })

  it('returns 400 when target_id is missing', async () => {
    const entity = await createTestEntity({ name: 'SomeEntity' })
    const res = await testPost(ctx.app, `/api/v1/entities/${entity.id}/merge`, {})
    expect(res.status).toBe(400)
  })

  it('returns 400 when merging entity with itself', async () => {
    const entity = await createTestEntity({ name: 'SelfMerge' })
    const res = await testPost(ctx.app, `/api/v1/entities/${entity.id}/merge`, {
      target_id: entity.id,
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when source entity does not exist', async () => {
    const target = await createTestEntity({ name: 'Target' })
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await testPost(ctx.app, `/api/v1/entities/${fakeId}/merge`, {
      target_id: target.id,
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when target entity does not exist', async () => {
    const source = await createTestEntity({ name: 'Source' })
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await testPost(ctx.app, `/api/v1/entities/${source.id}/merge`, {
      target_id: fakeId,
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/split — Split alias to new entity
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/split', () => {
  it('splits an alias into a new entity', async () => {
    const entity = await createTestEntity({
      name: 'Machine Learning',
      entity_type: 'concept',
      aliases: ['ML', 'deep learning'],
    })

    const res = await testPost(ctx.app, `/api/v1/entities/${entity.id}/split`, {
      alias: 'deep learning',
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.source_entity_id).toBe(entity.id)
    expect(body.new_entity_id).toBeDefined()
    expect(body.alias).toBe('deep learning')

    // Original entity should no longer have the split alias
    const originalRes = await testGet(ctx.app, `/api/v1/entities/${entity.id}`)
    const originalBody = await originalRes.json()
    expect(originalBody.aliases).not.toContain('deep learning')
    expect(originalBody.aliases).toContain('ML') // other aliases preserved

    // New entity should exist
    const newRes = await testGet(ctx.app, `/api/v1/entities/${body.new_entity_id}`)
    expect(newRes.status).toBe(200)
    const newBody = await newRes.json()
    expect(newBody.name).toBe('deep learning')
    expect(newBody.entity_type).toBe('concept') // inherits type from parent
  })

  it('returns 400 when alias is missing', async () => {
    const entity = await createTestEntity({ name: 'SomeEntity', aliases: ['alias1'] })
    const res = await testPost(ctx.app, `/api/v1/entities/${entity.id}/split`, {})
    expect(res.status).toBe(400)
  })

  it('returns 404 when entity does not exist', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await testPost(ctx.app, `/api/v1/entities/${fakeId}/split`, {
      alias: 'whatever',
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Entity-capture relationship accuracy
// ---------------------------------------------------------------------------

describe('Entity-capture relationships', () => {
  it('mention_count accurately reflects entity_links count', async () => {
    const entity = await createTestEntity({ name: 'AccuracyTest' })
    const captures = []
    for (let i = 0; i < 5; i++) {
      captures.push(await createTestCapture({ content: `Capture for accuracy ${i}` }))
    }

    // Link 3 captures
    await linkEntityToCapture(entity.id as string, captures[0].id as string)
    await linkEntityToCapture(entity.id as string, captures[1].id as string)
    await linkEntityToCapture(entity.id as string, captures[2].id as string)

    // Check in list
    const listRes = await testGet(ctx.app, '/api/v1/entities?limit=10')
    const listBody = await listRes.json()
    const listed = listBody.items.find((e: any) => e.name === 'AccuracyTest')
    expect(listed).toBeDefined()
    expect(listed.mention_count).toBe(3)

    // Check in detail
    const detailRes = await testGet(ctx.app, `/api/v1/entities/${entity.id}`)
    const detailBody = await detailRes.json()
    expect(detailBody.mention_count).toBe(3)
    expect(detailBody.linked_captures).toHaveLength(3)
  })

  it('seeded data has correct entity counts and relationships', async () => {
    const data = await seedTestData()

    // Verify through API
    const listRes = await testGet(ctx.app, '/api/v1/entities?limit=10')
    const listBody = await listRes.json()
    expect(listBody.total).toBe(data.entities.length)

    // PostgreSQL entity should have 1 link
    const pgEntity = listBody.items.find((e: any) => e.name === 'PostgreSQL')
    expect(pgEntity).toBeDefined()
    expect(pgEntity.mention_count).toBe(1)

    // LLM entity should have 1 link
    const llmEntity = listBody.items.find((e: any) => e.name === 'LLM')
    expect(llmEntity).toBeDefined()
    expect(llmEntity.mention_count).toBe(1)

    // Weekly Brief entity should have 1 link
    const wbEntity = listBody.items.find((e: any) => e.name === 'Weekly Brief')
    expect(wbEntity).toBeDefined()
    expect(wbEntity.mention_count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Date handling (regression test for "Invalid Date" bug)
// ---------------------------------------------------------------------------

describe('Entity date handling', () => {
  it('entity date fields are valid (no Invalid Date)', async () => {
    const entity = await createTestEntity({ name: 'DateTest' })

    const res = await testGet(ctx.app, `/api/v1/entities/${entity.id}`)
    const body = await res.json()

    // Check all date fields parse correctly
    for (const field of ['created_at', 'updated_at', 'first_seen_at', 'last_seen_at']) {
      const value = body[field]
      if (value !== null && value !== undefined) {
        const parsed = new Date(value)
        expect(parsed.toString()).not.toBe('Invalid Date')
      }
    }
  })

  it('linked capture dates are valid in entity detail', async () => {
    const entity = await createTestEntity({ name: 'CapDateTest' })
    const capture = await createTestCapture({
      content: 'Capture with specific date',
      captured_at: new Date('2026-02-15T08:00:00.000Z'),
    })
    await linkEntityToCapture(entity.id as string, capture.id as string)

    const res = await testGet(ctx.app, `/api/v1/entities/${entity.id}`)
    const body = await res.json()

    for (const lc of body.linked_captures) {
      if (lc.created_at) {
        const parsed = new Date(lc.created_at)
        expect(parsed.toString()).not.toBe('Invalid Date')
      }
    }
  })
})
