import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import type { EntityService } from '../services/entity.js'

// ---------------------------------------------------------------------------
// Mock EntityService
// ---------------------------------------------------------------------------

const SAMPLE_ENTITY = {
  id: 'entity-uuid-1',
  name: 'Tom Smith',
  entity_type: 'person',
  canonical_name: 'tom smith',
  aliases: ['Tom', 'Tommy'],
  metadata: null,
  mention_count: 5,
  first_seen_at: new Date('2026-01-01T00:00:00Z'),
  last_seen_at: new Date('2026-03-01T00:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-03-01T00:00:00Z'),
}

const SAMPLE_LINKED_CAPTURE = {
  id: 'cap-uuid-1',
  content: 'Discussed QSR project timeline with Tom Smith',
  capture_type: 'observation',
  brain_view: 'work-internal',
  relationship: 'mentioned',
  confidence: 0.9,
  created_at: new Date('2026-03-01T10:00:00Z'),
}

const SAMPLE_DETAIL = {
  ...SAMPLE_ENTITY,
  linked_captures: [SAMPLE_LINKED_CAPTURE],
}

function makeMockEntityService(overrides: Partial<EntityService> = {}): EntityService {
  return {
    list: vi.fn().mockResolvedValue({ items: [SAMPLE_ENTITY], total: 1 }),
    getById: vi.fn().mockResolvedValue(SAMPLE_DETAIL),
    getByName: vi.fn().mockResolvedValue(SAMPLE_ENTITY),
    merge: vi.fn().mockResolvedValue(undefined),
    split: vi.fn().mockResolvedValue({ new_entity_id: 'new-entity-uuid' }),
    recordMention: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EntityService
}

// ---------------------------------------------------------------------------
// GET /api/v1/entities — list
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities', () => {
  it('returns paginated entity list with defaults', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.items).toHaveLength(1)
    expect(body.items[0].name).toBe('Tom Smith')
    expect(body.total).toBe(1)
    expect(body.limit).toBe(20)
    expect(body.offset).toBe(0)
    expect(entityService.list).toHaveBeenCalledWith({
      type_filter: undefined,
      sort_by: 'mention_count',
      limit: 20,
      offset: 0,
    })
  })

  it('passes type_filter, sort_by, limit, offset to EntityService', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities?type_filter=person&sort_by=name&limit=10&offset=5')

    expect(res.status).toBe(200)
    expect(entityService.list).toHaveBeenCalledWith({
      type_filter: 'person',
      sort_by: 'name',
      limit: 10,
      offset: 5,
    })
  })

  it('caps limit at 100', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    await app.request('/api/v1/entities?limit=9999')

    expect(entityService.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    )
  })

  it('defaults to mention_count sort for invalid sort_by', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    await app.request('/api/v1/entities?sort_by=invalid')

    expect(entityService.list).toHaveBeenCalledWith(
      expect.objectContaining({ sort_by: 'mention_count' }),
    )
  })

  it('returns entity by name when ?name= is provided', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities?name=Tom+Smith')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.entity.name).toBe('Tom Smith')
    expect(entityService.getByName).toHaveBeenCalledWith('Tom Smith')
  })

  it('returns 404 when ?name= entity not found', async () => {
    const entityService = makeMockEntityService({
      getByName: vi.fn().mockResolvedValue(null),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities?name=Unknown')

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/entities/:id — detail
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities/:id', () => {
  it('returns entity detail with linked captures', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.name).toBe('Tom Smith')
    expect(body.linked_captures).toHaveLength(1)
    expect(body.linked_captures[0].content).toContain('Tom Smith')
    expect(entityService.getById).toHaveBeenCalledWith('entity-uuid-1')
  })

  it('returns 404 when entity not found', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const entityService = makeMockEntityService({
      getById: vi.fn().mockRejectedValue(new NotFoundError('Entity not found: xyz')),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/nonexistent-uuid')

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/merge
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/merge', () => {
  it('merges source into target entity', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/source-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: 'target-id' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.source_id).toBe('source-id')
    expect(body.target_id).toBe('target-id')
    expect(entityService.merge).toHaveBeenCalledWith('source-id', 'target-id')
  })

  it('returns 400 when target_id is missing', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/source-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when source and target are the same', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/same-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: 'same-id' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 on invalid JSON body', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/source-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })

    expect(res.status).toBe(400)
  })

  it('returns 404 when source entity not found', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const entityService = makeMockEntityService({
      merge: vi.fn().mockRejectedValue(new NotFoundError('Source entity not found: bad-id')),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/bad-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: 'target-id' }),
    })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/split
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/split', () => {
  it('splits alias into new entity', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'Tommy' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.new_entity_id).toBe('new-entity-uuid')
    expect(body.source_entity_id).toBe('entity-uuid-1')
    expect(body.alias).toBe('Tommy')
    expect(entityService.split).toHaveBeenCalledWith('entity-uuid-1', 'Tommy')
  })

  it('returns 400 when alias is missing', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 on invalid JSON body', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad-json',
    })

    expect(res.status).toBe(400)
  })

  it('returns 404 when entity not found', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const entityService = makeMockEntityService({
      split: vi.fn().mockRejectedValue(new NotFoundError('Entity not found: bad-id')),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/bad-id/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'Tommy' }),
    })

    expect(res.status).toBe(404)
  })
})
