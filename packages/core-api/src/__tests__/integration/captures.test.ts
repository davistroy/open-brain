/**
 * Integration tests — Captures API
 *
 * Exercises the full CRUD lifecycle against a real Postgres database:
 *   POST /api/v1/captures  — create
 *   GET  /api/v1/captures  — list with filters and pagination
 *   GET  /api/v1/captures/:id — get by ID
 *   PATCH /api/v1/captures/:id — update tags/brain_view/metadata
 *   DELETE /api/v1/captures/:id — soft delete
 *
 * Also verifies:
 *   - Date fields roundtrip correctly (no "Invalid Date" regression)
 *   - Duplicate detection within 60s window
 *   - Pagination with limit/offset
 *   - Filter combinations (brain_view, capture_type, source, pipeline_status)
 *   - Stats endpoint reflects accurate entity count
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
  testGet,
  testPost,
  testPatch,
  testDelete,
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
// POST /api/v1/captures — Create
// ---------------------------------------------------------------------------

describe('POST /api/v1/captures', () => {
  it('creates a capture and returns 201 with id and pipeline_status', async () => {
    const res = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Integration test: create capture',
      capture_type: 'idea',
      brain_view: 'technical',
      source: 'api',
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBeDefined()
    expect(typeof body.id).toBe('string')
    expect(body.pipeline_status).toBe('pending')
    expect(body.created_at).toBeDefined()
  })

  it('returns valid ISO datetime strings for created_at', async () => {
    const res = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Date handling test',
      capture_type: 'observation',
      brain_view: 'career',
      source: 'api',
    })

    expect(res.status).toBe(201)
    const body = await res.json()

    // Verify created_at is a valid date (not "Invalid Date")
    const parsed = new Date(body.created_at)
    expect(parsed.toString()).not.toBe('Invalid Date')
    expect(parsed.getFullYear()).toBeGreaterThanOrEqual(2026)
  })

  it('defaults source to api when omitted', async () => {
    const res = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Source default test',
      capture_type: 'idea',
      brain_view: 'technical',
    })

    expect(res.status).toBe(201)

    // Verify via GET
    const body = await res.json()
    const getRes = await testGet(ctx.app, `/api/v1/captures/${body.id}`)
    const capture = await getRes.json()
    expect(capture.source).toBe('api')
  })

  it('rejects duplicate content within 60s window', async () => {
    const payload = {
      content: 'Duplicate detection test content',
      capture_type: 'decision',
      brain_view: 'technical',
      source: 'api',
    }

    const first = await testPost(ctx.app, '/api/v1/captures', payload)
    expect(first.status).toBe(201)

    const second = await testPost(ctx.app, '/api/v1/captures', payload)
    expect(second.status).toBe(409)
    const body = await second.json()
    expect(body.code).toBe('CONFLICT')
  })

  it('rejects missing required fields', async () => {
    // Missing content
    const res = await testPost(ctx.app, '/api/v1/captures', {
      capture_type: 'idea',
      brain_view: 'technical',
    })
    expect(res.status).toBe(400)
  })

  it('rejects invalid capture_type', async () => {
    const res = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Invalid type test',
      capture_type: 'nonexistent_type',
      brain_view: 'technical',
      source: 'api',
    })
    expect(res.status).toBe(400)
  })

  it('rejects invalid brain_view', async () => {
    const res = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Invalid view test',
      capture_type: 'idea',
      brain_view: 'nonexistent_view',
      source: 'api',
    })
    // brain_view is validated at service layer via ConfigService — returns 422
    expect([400, 422]).toContain(res.status)
  })

  it('accepts metadata with tags and captured_at', async () => {
    const capturedAt = '2026-01-15T10:30:00.000Z'
    const res = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Metadata test capture',
      capture_type: 'task',
      brain_view: 'technical',
      source: 'api',
      metadata: {
        tags: ['test', 'integration'],
        captured_at: capturedAt,
      },
    })

    expect(res.status).toBe(201)
    const body = await res.json()

    // Verify metadata roundtrips via GET
    const getRes = await testGet(ctx.app, `/api/v1/captures/${body.id}`)
    const capture = await getRes.json()
    expect(capture.tags).toEqual(['test', 'integration'])

    // captured_at should reflect the provided value
    const parsedCapturedAt = new Date(capture.captured_at)
    expect(parsedCapturedAt.toISOString()).toBe(capturedAt)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/captures — List
// ---------------------------------------------------------------------------

describe('GET /api/v1/captures', () => {
  it('returns empty list when no captures exist', async () => {
    const res = await testGet(ctx.app, '/api/v1/captures?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
  })

  it('returns captures ordered by created_at descending', async () => {
    // Create captures with small delays to guarantee ordering
    await createTestCapture({ content: 'First capture', capture_type: 'idea', brain_view: 'technical' })
    await createTestCapture({ content: 'Second capture', capture_type: 'decision', brain_view: 'career' })
    await createTestCapture({ content: 'Third capture', capture_type: 'task', brain_view: 'personal' })

    const res = await testGet(ctx.app, '/api/v1/captures?limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(3)
    expect(body.total).toBe(3)

    // Most recent first
    expect(body.items[0].content).toBe('Third capture')
    expect(body.items[2].content).toBe('First capture')
  })

  it('filters by brain_view', async () => {
    await createTestCapture({ content: 'Tech capture', brain_view: 'technical' })
    await createTestCapture({ content: 'Career capture', brain_view: 'career' })
    await createTestCapture({ content: 'Personal capture', brain_view: 'personal' })

    const res = await testGet(ctx.app, '/api/v1/captures?brain_view=technical&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].content).toBe('Tech capture')
    expect(body.total).toBe(1)
  })

  it('filters by capture_type', async () => {
    await createTestCapture({ content: 'Idea one', capture_type: 'idea' })
    await createTestCapture({ content: 'Decision one', capture_type: 'decision' })
    await createTestCapture({ content: 'Idea two', capture_type: 'idea' })

    const res = await testGet(ctx.app, '/api/v1/captures?capture_type=idea&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items.every((c: any) => c.capture_type === 'idea')).toBe(true)
  })

  it('filters by source', async () => {
    await createTestCapture({ content: 'API capture', source: 'api' })
    await createTestCapture({ content: 'Slack capture', source: 'slack' })

    const res = await testGet(ctx.app, '/api/v1/captures?source=slack&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].content).toBe('Slack capture')
  })

  it('filters by pipeline_status', async () => {
    await createTestCapture({ content: 'Pending one', pipeline_status: 'pending' })
    await createTestCapture({ content: 'Complete one', pipeline_status: 'complete' })
    await createTestCapture({ content: 'Failed one', pipeline_status: 'failed' })

    const res = await testGet(ctx.app, '/api/v1/captures?pipeline_status=failed&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].content).toBe('Failed one')
  })

  it('supports pagination with limit and offset', async () => {
    // Create 25 captures
    for (let i = 0; i < 25; i++) {
      await createTestCapture({ content: `Pagination capture ${i.toString().padStart(2, '0')}` })
    }

    // Page 1: first 10
    const page1 = await testGet(ctx.app, '/api/v1/captures?limit=10&offset=0')
    const body1 = await page1.json()
    expect(body1.items).toHaveLength(10)
    expect(body1.total).toBe(25)
    expect(body1.limit).toBe(10)
    expect(body1.offset).toBe(0)

    // Page 2: next 10
    const page2 = await testGet(ctx.app, '/api/v1/captures?limit=10&offset=10')
    const body2 = await page2.json()
    expect(body2.items).toHaveLength(10)
    expect(body2.total).toBe(25)

    // Page 3: last 5
    const page3 = await testGet(ctx.app, '/api/v1/captures?limit=10&offset=20')
    const body3 = await page3.json()
    expect(body3.items).toHaveLength(5)
    expect(body3.total).toBe(25)

    // No overlap between pages
    const ids1 = new Set(body1.items.map((c: any) => c.id))
    const ids2 = new Set(body2.items.map((c: any) => c.id))
    const ids3 = new Set(body3.items.map((c: any) => c.id))
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false)
    }
    for (const id of ids3) {
      expect(ids1.has(id)).toBe(false)
      expect(ids2.has(id)).toBe(false)
    }
  })

  it('defaults to limit=20 when not specified', async () => {
    for (let i = 0; i < 25; i++) {
      await createTestCapture({ content: `Default limit capture ${i}` })
    }

    const res = await testGet(ctx.app, '/api/v1/captures')
    const body = await res.json()
    expect(body.items).toHaveLength(20)
    expect(body.total).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/captures/:id — Get by ID
// ---------------------------------------------------------------------------

describe('GET /api/v1/captures/:id', () => {
  it('returns a capture by ID with all fields', async () => {
    const created = await createTestCapture({
      content: 'Detail test capture',
      capture_type: 'decision',
      brain_view: 'career',
      source: 'slack',
      tags: ['important'],
    })

    const res = await testGet(ctx.app, `/api/v1/captures/${created.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.id).toBe(created.id)
    expect(body.content).toBe('Detail test capture')
    expect(body.capture_type).toBe('decision')
    expect(body.brain_view).toBe('career')
    expect(body.source).toBe('slack')
    expect(body.tags).toEqual(['important'])
    expect(body.pipeline_status).toBe('pending')
  })

  it('returns valid date fields (no Invalid Date regression)', async () => {
    const capturedAt = new Date('2026-02-20T14:00:00.000Z')
    const created = await createTestCapture({
      content: 'Date field test',
      captured_at: capturedAt,
    })

    const res = await testGet(ctx.app, `/api/v1/captures/${created.id}`)
    const body = await res.json()

    // Verify all date fields parse correctly
    for (const field of ['created_at', 'updated_at', 'captured_at']) {
      const value = body[field]
      if (value !== null && value !== undefined) {
        const parsed = new Date(value)
        expect(parsed.toString()).not.toBe('Invalid Date')
      }
    }

    // Specifically verify captured_at matches input
    const parsedCapturedAt = new Date(body.captured_at)
    expect(parsedCapturedAt.toISOString()).toBe(capturedAt.toISOString())
  })

  it('returns 404 for nonexistent capture', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await testGet(ctx.app, `/api/v1/captures/${fakeId}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/captures/:id — Update
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/captures/:id', () => {
  it('updates tags', async () => {
    const created = await createTestCapture({ content: 'Tag update test' })

    const res = await testPatch(ctx.app, `/api/v1/captures/${created.id}`, {
      tags: ['updated', 'test'],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tags).toEqual(['updated', 'test'])
  })

  it('updates brain_view', async () => {
    const created = await createTestCapture({ content: 'View update test', brain_view: 'technical' })

    const res = await testPatch(ctx.app, `/api/v1/captures/${created.id}`, {
      brain_view: 'career',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.brain_view).toBe('career')
  })

  it('merges metadata_overrides into source_metadata', async () => {
    const created = await createTestCapture({ content: 'Metadata merge test' })

    const res = await testPatch(ctx.app, `/api/v1/captures/${created.id}`, {
      metadata_overrides: { priority: 'high', category: 'test' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source_metadata).toBeDefined()
    expect(body.source_metadata.priority).toBe('high')
    expect(body.source_metadata.category).toBe('test')
  })

  it('returns 404 for nonexistent capture', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await testPatch(ctx.app, `/api/v1/captures/${fakeId}`, { tags: ['x'] })
    expect(res.status).toBe(404)
  })

  it('preserves original content after update', async () => {
    const created = await createTestCapture({ content: 'Preserve content test' })

    await testPatch(ctx.app, `/api/v1/captures/${created.id}`, {
      tags: ['new-tag'],
    })

    const getRes = await testGet(ctx.app, `/api/v1/captures/${created.id}`)
    const body = await getRes.json()
    expect(body.content).toBe('Preserve content test')
    expect(body.tags).toEqual(['new-tag'])
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/captures/:id — Soft delete
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/captures/:id', () => {
  it('soft-deletes a capture (returns 204)', async () => {
    const created = await createTestCapture({ content: 'Delete me' })

    const deleteRes = await testDelete(ctx.app, `/api/v1/captures/${created.id}`)
    expect(deleteRes.status).toBe(204)

    // GET should now return 404
    const getRes = await testGet(ctx.app, `/api/v1/captures/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  it('soft-deleted captures do not appear in list', async () => {
    const keep = await createTestCapture({ content: 'Keep me' })
    const remove = await createTestCapture({ content: 'Remove me' })

    await testDelete(ctx.app, `/api/v1/captures/${remove.id}`)

    const res = await testGet(ctx.app, '/api/v1/captures?limit=10')
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe(keep.id)
    expect(body.total).toBe(1)
  })

  it('returns 404 when deleting nonexistent capture', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await testDelete(ctx.app, `/api/v1/captures/${fakeId}`)
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Full CRUD lifecycle
// ---------------------------------------------------------------------------

describe('Captures CRUD lifecycle', () => {
  it('create -> list -> get -> update -> verify -> delete -> verify', async () => {
    // CREATE
    const createRes = await testPost(ctx.app, '/api/v1/captures', {
      content: 'Full lifecycle test',
      capture_type: 'reflection',
      brain_view: 'personal',
      source: 'api',
    })
    expect(createRes.status).toBe(201)
    const { id } = await createRes.json()

    // LIST — should contain our capture
    const listRes = await testGet(ctx.app, '/api/v1/captures?limit=10')
    const listBody = await listRes.json()
    expect(listBody.items.some((c: any) => c.id === id)).toBe(true)

    // GET by ID
    const getRes = await testGet(ctx.app, `/api/v1/captures/${id}`)
    expect(getRes.status).toBe(200)
    const capture = await getRes.json()
    expect(capture.content).toBe('Full lifecycle test')

    // UPDATE
    const patchRes = await testPatch(ctx.app, `/api/v1/captures/${id}`, {
      tags: ['lifecycle', 'tested'],
      brain_view: 'career',
    })
    expect(patchRes.status).toBe(200)
    const updated = await patchRes.json()
    expect(updated.tags).toEqual(['lifecycle', 'tested'])
    expect(updated.brain_view).toBe('career')

    // VERIFY update persisted
    const verifyRes = await testGet(ctx.app, `/api/v1/captures/${id}`)
    const verified = await verifyRes.json()
    expect(verified.tags).toEqual(['lifecycle', 'tested'])
    expect(verified.brain_view).toBe('career')
    expect(verified.content).toBe('Full lifecycle test') // content preserved

    // DELETE
    const deleteRes = await testDelete(ctx.app, `/api/v1/captures/${id}`)
    expect(deleteRes.status).toBe(204)

    // VERIFY deleted
    const afterDelete = await testGet(ctx.app, `/api/v1/captures/${id}`)
    expect(afterDelete.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/stats — Stats endpoint (entity count accuracy regression)
// ---------------------------------------------------------------------------

describe('GET /api/v1/stats', () => {
  it('returns accurate capture counts by source, type, and view', async () => {
    await createTestCapture({ content: 'Stat 1', capture_type: 'idea', brain_view: 'technical', source: 'api' })
    await createTestCapture({ content: 'Stat 2', capture_type: 'decision', brain_view: 'career', source: 'slack' })
    await createTestCapture({ content: 'Stat 3', capture_type: 'idea', brain_view: 'technical', source: 'api' })

    const res = await testGet(ctx.app, '/api/v1/stats')
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.total_captures).toBe(3)
    expect(body.by_source.api).toBe(2)
    expect(body.by_source.slack).toBe(1)
    expect(body.by_type.idea).toBe(2)
    expect(body.by_type.decision).toBe(1)
    expect(body.by_view.technical).toBe(2)
    expect(body.by_view.career).toBe(1)
  })

  it('returns accurate entity count (regression: total_entities was 0)', async () => {
    // Create entities directly
    await createTestEntity({ name: 'EntityA', entity_type: 'concept' })
    await createTestEntity({ name: 'EntityB', entity_type: 'tool' })
    await createTestEntity({ name: 'EntityC', entity_type: 'person' })

    const res = await testGet(ctx.app, '/api/v1/stats')
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.total_entities).toBe(3)
  })

  it('returns correct pipeline health breakdown', async () => {
    await createTestCapture({ content: 'Pending 1', pipeline_status: 'pending' })
    await createTestCapture({ content: 'Pending 2', pipeline_status: 'pending' })
    await createTestCapture({ content: 'Complete 1', pipeline_status: 'complete' })
    await createTestCapture({ content: 'Failed 1', pipeline_status: 'failed' })

    const res = await testGet(ctx.app, '/api/v1/stats')
    const body = await res.json()

    expect(body.pipeline_health.pending).toBe(2)
    expect(body.pipeline_health.complete).toBe(1)
    expect(body.pipeline_health.failed).toBe(1)
    expect(body.pipeline_health.processing).toBe(0)
  })
})
