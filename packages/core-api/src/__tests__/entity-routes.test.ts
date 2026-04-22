import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import type { EntityService } from '../services/entity.js'
import type { LLMGatewayService } from '@open-brain/shared'
import type { SearchService } from '../services/search.js'
import type { Queue } from 'bullmq'

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

const SAMPLE_RELATED = [
  { id: 'entity-uuid-2', name: 'Alice Jones', type: 'person', shared_count: 3 },
  { id: 'entity-uuid-3', name: 'QSR Project', type: 'project', shared_count: 1 },
]

// Target entity returned by a successful merge — represents the updated target
const MERGE_TARGET_ENTITY = {
  id: 'target-id',
  name: 'Target Entity',
  entity_type: 'person',
  canonical_name: 'target entity',
  aliases: ['Source Entity'],  // source name added during merge
  metadata: null,
  mention_count: 7,
  first_seen_at: new Date('2026-01-01T00:00:00Z'),
  last_seen_at: new Date('2026-04-01T00:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-04-22T00:00:00Z'),
}

function makeMockEntityService(overrides: Partial<EntityService> = {}): EntityService {
  return {
    list: vi.fn().mockResolvedValue({ items: [SAMPLE_ENTITY], total: 1 }),
    getById: vi.fn().mockResolvedValue(SAMPLE_DETAIL),
    getByName: vi.fn().mockResolvedValue(SAMPLE_ENTITY),
    merge: vi.fn().mockResolvedValue(MERGE_TARGET_ENTITY),
    split: vi.fn().mockResolvedValue({ new_entity_id: 'new-entity-uuid' }),
    recordMention: vi.fn().mockResolvedValue(undefined),
    entityExists: vi.fn().mockResolvedValue(true),
    getRelated: vi.fn().mockResolvedValue(SAMPLE_RELATED),
    getMentionsTimeline: vi.fn().mockResolvedValue([]),
    ask: vi.fn().mockResolvedValue({
      response: 'Tom Smith leads the QSR project and is a key stakeholder.',
      capture_count: 3,
      entity: { id: 'entity-uuid-1', name: 'Tom Smith', type: 'person' },
    }),
    ...overrides,
  } as unknown as EntityService
}

function makeMockSkillQueue(jobId = 'job-abc-123'): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: jobId }),
  } as unknown as Queue
}

function makeMockSearchService(): SearchService {
  return {
    search: vi.fn().mockResolvedValue([]),
  } as unknown as SearchService
}

function makeMockLLMGateway(): LLMGatewayService {
  return {
    completeByTask: vi.fn().mockResolvedValue('Tom Smith leads the QSR project.'),
  } as unknown as LLMGatewayService
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
  it('merges source into target entity and returns updated target', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/source-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: 'target-id' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    // Route returns the full target entity record (not a summary envelope)
    expect(body.id).toBe('target-id')
    expect(body.name).toBe('Target Entity')
    expect(body.entity_type).toBe('person')
    // Source name should appear in target aliases after merge
    expect(body.aliases).toContain('Source Entity')
    expect(entityService.merge).toHaveBeenCalledWith('source-id', 'target-id')
  })

  it('handles duplicate entity_links gracefully (ON CONFLICT DO NOTHING)', async () => {
    // When target already has a link to the same capture as source, the merge
    // should succeed (not throw a unique-constraint violation).
    // The service skips duplicate links via INSERT ... ON CONFLICT DO NOTHING.
    const entityService = makeMockEntityService({
      merge: vi.fn().mockResolvedValue({
        ...MERGE_TARGET_ENTITY,
        // mention_count unchanged because the duplicate link was skipped
        mention_count: 5,
      }),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/source-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: 'target-id' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe('target-id')
    // merge was called — duplicate handling is internal to the service
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

  it('returns 404 when target entity not found', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const entityService = makeMockEntityService({
      merge: vi.fn().mockRejectedValue(new NotFoundError('Target entity not found: missing-target')),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/source-id/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: 'missing-target' }),
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

// ---------------------------------------------------------------------------
// GET /api/v1/entities/:id/related
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities/:id/related', () => {
  it('returns related entities with shared_count', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/related')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.related).toHaveLength(2)
    expect(body.related[0].name).toBe('Alice Jones')
    expect(body.related[0].shared_count).toBe(3)
    expect(entityService.entityExists).toHaveBeenCalledWith('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(entityService.getRelated).toHaveBeenCalledWith('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 20)
  })

  it('returns empty related array when no co-occurrences', async () => {
    const entityService = makeMockEntityService({
      getRelated: vi.fn().mockResolvedValue([]),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/related')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.related).toHaveLength(0)
  })

  it('respects limit query param (capped at 100)', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    await app.request('/api/v1/entities/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/related?limit=50')
    expect(entityService.getRelated).toHaveBeenCalledWith('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 50)

    await app.request('/api/v1/entities/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/related?limit=999')
    expect(entityService.getRelated).toHaveBeenCalledWith('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100)
  })

  it('returns 404 when entity does not exist', async () => {
    const entityService = makeMockEntityService({
      entityExists: vi.fn().mockResolvedValue(false),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/related')

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('NOT_FOUND')
    expect(entityService.getRelated).not.toHaveBeenCalled()
  })

  it('returns 404 for malformed (non-UUID) id', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/not-a-uuid/related')

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('NOT_FOUND')
    expect(entityService.entityExists).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/entities/:id/mentions-timeline
// ---------------------------------------------------------------------------

const SAMPLE_BUCKETS = [
  { period: '2026-01-01', count: 3 },
  { period: '2026-01-08', count: 1 },
  { period: '2026-01-15', count: 2 },
]

describe('GET /api/v1/entities/:id/mentions-timeline', () => {
  it('returns buckets with defaults (window=30d, bucket=week)', async () => {
    const entityService = makeMockEntityService({
      getMentionsTimeline: vi.fn().mockResolvedValue(SAMPLE_BUCKETS),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.buckets).toHaveLength(3)
    expect(body.buckets[0]).toEqual({ period: '2026-01-01', count: 3 })
    expect(body.window).toBe('30d')
    expect(body.bucket).toBe('week')
    expect(entityService.getMentionsTimeline).toHaveBeenCalledWith('entity-uuid-1', '30d', 'week')
  })

  it('passes window and bucket query params to service', async () => {
    const entityService = makeMockEntityService({
      getMentionsTimeline: vi.fn().mockResolvedValue(SAMPLE_BUCKETS),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline?window=90d&bucket=month')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.window).toBe('90d')
    expect(body.bucket).toBe('month')
    expect(entityService.getMentionsTimeline).toHaveBeenCalledWith('entity-uuid-1', '90d', 'month')
  })

  it('returns 400 for invalid window value', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline?window=60d')

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for invalid bucket value', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline?bucket=hour')

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for disallowed combo: bucket=day + window=365d', async () => {
    const entityService = makeMockEntityService()
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline?window=365d&bucket=day')

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('bucket=day is not allowed with window=365d')
  })

  it('returns 404 when entity does not exist', async () => {
    const entityService = makeMockEntityService({
      entityExists: vi.fn().mockResolvedValue(false),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/nonexistent-uuid/mentions-timeline')

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('NOT_FOUND')
  })

  it('does not call getMentionsTimeline when entity does not exist', async () => {
    const entityService = makeMockEntityService({
      entityExists: vi.fn().mockResolvedValue(false),
    })
    const app = createApp({ entityService })

    await app.request('/api/v1/entities/nonexistent-uuid/mentions-timeline')

    expect(entityService.getMentionsTimeline).not.toHaveBeenCalled()
  })

  it('returns empty buckets array when entity has no mentions in window', async () => {
    const entityService = makeMockEntityService({
      getMentionsTimeline: vi.fn().mockResolvedValue([]),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline?window=7d&bucket=day')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.buckets).toEqual([])
    expect(body.window).toBe('7d')
    expect(body.bucket).toBe('day')
  })

  it('allows bucket=day with window=7d (valid combo)', async () => {
    const entityService = makeMockEntityService({
      getMentionsTimeline: vi.fn().mockResolvedValue(SAMPLE_BUCKETS),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline?window=7d&bucket=day')

    expect(res.status).toBe(200)
  })

  it('allows bucket=week with window=365d (valid combo)', async () => {
    const entityService = makeMockEntityService({
      getMentionsTimeline: vi.fn().mockResolvedValue(SAMPLE_BUCKETS),
    })
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/mentions-timeline?window=365d&bucket=week')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.window).toBe('365d')
    expect(body.bucket).toBe('week')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/ask
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/ask', () => {
  it('returns synthesized response with entity metadata', async () => {
    const entityService = makeMockEntityService()
    const searchService = makeMockSearchService()
    const llmGateway = makeMockLLMGateway()
    const app = createApp({ entityService, searchService, llmGateway })

    const res = await app.request('/api/v1/entities/entity-uuid-1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What does Tom Smith work on?' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.response).toBe('Tom Smith leads the QSR project and is a key stakeholder.')
    expect(body.capture_count).toBe(3)
    expect(body.entity.id).toBe('entity-uuid-1')
    expect(body.entity.name).toBe('Tom Smith')
    expect(body.entity.type).toBe('person')
    expect(entityService.entityExists).toHaveBeenCalledWith('entity-uuid-1')
    expect(entityService.ask).toHaveBeenCalledWith(
      'entity-uuid-1',
      'What does Tom Smith work on?',
      searchService,
      llmGateway,
    )
  })

  it('returns 404 when entity does not exist', async () => {
    const entityService = makeMockEntityService({
      entityExists: vi.fn().mockResolvedValue(false),
    })
    const searchService = makeMockSearchService()
    const llmGateway = makeMockLLMGateway()
    const app = createApp({ entityService, searchService, llmGateway })

    const res = await app.request('/api/v1/entities/nonexistent-uuid/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What does this entity do?' }),
    })

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('NOT_FOUND')
    expect(entityService.ask).not.toHaveBeenCalled()
  })

  it('returns 400 when question is missing', async () => {
    const entityService = makeMockEntityService()
    const searchService = makeMockSearchService()
    const llmGateway = makeMockLLMGateway()
    const app = createApp({ entityService, searchService, llmGateway })

    const res = await app.request('/api/v1/entities/entity-uuid-1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when question exceeds 2000 chars', async () => {
    const entityService = makeMockEntityService()
    const searchService = makeMockSearchService()
    const llmGateway = makeMockLLMGateway()
    const app = createApp({ entityService, searchService, llmGateway })

    const res = await app.request('/api/v1/entities/entity-uuid-1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(2001) }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 503 when searchService is not configured', async () => {
    const entityService = makeMockEntityService()
    // omit searchService — endpoint should return 503
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What does Tom Smith work on?' }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('returns 503 when llmGateway is not configured', async () => {
    const entityService = makeMockEntityService()
    const searchService = makeMockSearchService()
    // omit llmGateway — endpoint should return 503
    const app = createApp({ entityService, searchService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What does Tom Smith work on?' }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('returns "no relevant captures" response when entity has no linked captures', async () => {
    const entityService = makeMockEntityService({
      ask: vi.fn().mockResolvedValue({
        response: "I couldn't find any captures in your brain that are relevant to this query. Try capturing more notes first.",
        capture_count: 0,
        entity: { id: 'entity-uuid-1', name: 'Tom Smith', type: 'person' },
      }),
    })
    const searchService = makeMockSearchService()
    const llmGateway = makeMockLLMGateway()
    const app = createApp({ entityService, searchService, llmGateway })

    const res = await app.request('/api/v1/entities/entity-uuid-1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What does Tom Smith work on?' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.capture_count).toBe(0)
    expect(body.response).toContain("couldn't find any captures")
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/brief
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/brief', () => {
  it('returns 202 with job_id when entity exists and skillQueue is present', async () => {
    const entityService = makeMockEntityService()
    const skillQueue = makeMockSkillQueue('job-abc-123')
    const app = createApp({ entityService, skillQueue })

    const res = await app.request('/api/v1/entities/entity-uuid-1/brief', {
      method: 'POST',
    })

    expect(res.status).toBe(202)
    const body = await res.json() as any
    expect(body.job_id).toBe('job-abc-123')
    expect(entityService.entityExists).toHaveBeenCalledWith('entity-uuid-1')
    expect(entityService.getById).toHaveBeenCalledWith('entity-uuid-1')
    expect(skillQueue.add).toHaveBeenCalledWith(
      'entity-brief',
      expect.objectContaining({
        skillName: 'entity-brief',
        input: expect.objectContaining({
          entityId: 'entity-uuid-1',
          entityName: 'Tom Smith',
          entityType: 'person',
        }),
      }),
      expect.objectContaining({ priority: 2 }),
    )
  })

  it('returns 404 when entity does not exist', async () => {
    const entityService = makeMockEntityService({
      entityExists: vi.fn().mockResolvedValue(false),
    })
    const skillQueue = makeMockSkillQueue()
    const app = createApp({ entityService, skillQueue })

    const res = await app.request('/api/v1/entities/nonexistent-uuid/brief', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('NOT_FOUND')
    expect(skillQueue.add).not.toHaveBeenCalled()
  })

  it('returns 503 when skillQueue is not configured', async () => {
    const entityService = makeMockEntityService()
    // omit skillQueue — endpoint should return 503
    const app = createApp({ entityService })

    const res = await app.request('/api/v1/entities/entity-uuid-1/brief', {
      method: 'POST',
    })

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('enqueues job with correct jobId prefix', async () => {
    const entityService = makeMockEntityService()
    const skillQueue = makeMockSkillQueue('job-xyz-999')
    const app = createApp({ entityService, skillQueue })

    await app.request('/api/v1/entities/entity-uuid-1/brief', {
      method: 'POST',
    })

    const addCall = (skillQueue.add as ReturnType<typeof vi.fn>).mock.calls[0]
    const jobOptions = addCall[2] as { jobId: string }
    expect(jobOptions.jobId).toMatch(/^entity_brief_entity-uuid-1_\d+$/)
  })
})
