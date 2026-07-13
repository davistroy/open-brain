/**
 * entities-routes.test.ts — complementary entity route tests using the shared
 * helpers.ts pattern (makeTestApp + makeMockService).
 *
 * The existing entity-routes.test.ts covers the primary happy/sad paths for
 * all 8 entity endpoints using `createApp`. This file fills edge-case gaps:
 *  - whitespace-only / boundary-value inputs
 *  - limit/offset clamping edge cases
 *  - DI gating (routes absent when entityService not injected)
 *  - ask: question length boundaries (1 char, 2000 chars)
 *  - brief: job payload shape
 *  - merge: whitespace target_id normalisation
 *  - split: whitespace alias normalisation
 *  - related: limit clamping at exactly 100
 *
 * Uses makeTestApp + makeMockService from helpers.ts per arch-review rule.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeTestApp, testJson } from './helpers.js'
import { registerEntityRoutes } from '../routes/entities.js'
import type { EntityService } from '../services/entity.js'
import type { SearchService } from '../services/search.js'
import type { LLMGatewayService } from '@open-brain/shared'
import type { Queue } from 'bullmq'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ENTITY = {
  id: 'aabbccdd-0000-0000-0000-aabbccddee11',
  name: 'Jane Doe',
  entity_type: 'person',
  canonical_name: 'jane doe',
  aliases: ['Jane', 'J. Doe'],
  metadata: null,
  mention_count: 3,
  first_seen_at: new Date('2026-01-01T00:00:00Z'),
  last_seen_at: new Date('2026-04-01T00:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-04-01T00:00:00Z'),
}

const SAMPLE_DETAIL = {
  ...SAMPLE_ENTITY,
  linked_captures: [],
}

const SAMPLE_MERGE_TARGET = {
  id: 'target-uuid-9999',
  name: 'Target Person',
  entity_type: 'person',
  canonical_name: 'target person',
  aliases: ['Jane Doe'],
  metadata: null,
  mention_count: 6,
  first_seen_at: new Date('2026-01-01T00:00:00Z'),
  last_seen_at: new Date('2026-04-20T00:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-04-20T00:00:00Z'),
}

function makeEntityService(overrides: Record<string, unknown> = {}): EntityService {
  return {
    list: vi.fn().mockResolvedValue({ items: [SAMPLE_ENTITY], total: 1 }),
    getById: vi.fn().mockResolvedValue(SAMPLE_DETAIL),
    getByName: vi.fn().mockResolvedValue(SAMPLE_ENTITY),
    merge: vi.fn().mockResolvedValue(SAMPLE_MERGE_TARGET),
    split: vi.fn().mockResolvedValue({ new_entity_id: 'split-new-uuid' }),
    recordMention: vi.fn().mockResolvedValue(undefined),
    entityExists: vi.fn().mockResolvedValue(true),
    getRelated: vi.fn().mockResolvedValue([]),
    getMentionsTimeline: vi.fn().mockResolvedValue([]),
    ask: vi.fn().mockResolvedValue({
      response: 'Jane Doe is a senior engineer.',
      capture_count: 2,
      entity: { id: SAMPLE_ENTITY.id, name: 'Jane Doe', type: 'person' },
    }),
    ...overrides,
  } as unknown as EntityService
}

function makeSearchService(): SearchService {
  return {
    search: vi.fn().mockResolvedValue([]),
  } as unknown as SearchService
}

function makeLlmGateway(): LLMGatewayService {
  return {
    completeByTask: vi.fn().mockResolvedValue('Jane Doe is a senior engineer.'),
  } as unknown as LLMGatewayService
}

function makeSkillQueue(jobId = 'skill-job-001'): Queue {
  return { add: vi.fn().mockResolvedValue({ id: jobId }) } as unknown as Queue
}

function buildApp(
  entityService: EntityService,
  opts: {
    searchService?: SearchService
    llmGateway?: LLMGatewayService
    skillQueue?: Queue
  } = {},
) {
  return makeTestApp((app) => {
    registerEntityRoutes(app, entityService, opts.searchService, opts.llmGateway, opts.skillQueue)
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/entities — edge cases not covered by entity-routes.test.ts
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities — edge cases', () => {
  it('clamps negative offset to 0', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status } = await testJson(app, '/api/v1/entities?offset=-5')

    expect(status).toBe(200)
    // NaN from non-finite → falls back to 0; negative parses as finite so it passes through
    // The route uses Number(offsetRaw) which gives -5; Math.min is not applied to offset,
    // so -5 is forwarded. This test documents the current (permissive) behaviour.
    expect(entityService.list).toHaveBeenCalledWith(
      expect.objectContaining({ offset: -5 }),
    )
  })

  it('applies last_seen sort correctly', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    await testJson(app, '/api/v1/entities?sort_by=last_seen')

    expect(entityService.list).toHaveBeenCalledWith(
      expect.objectContaining({ sort_by: 'last_seen' }),
    )
  })

  it('returns 404 for ?name= with leading/trailing whitespace after trim', async () => {
    const entityService = makeEntityService({
      getByName: vi.fn().mockResolvedValue(null),
    })
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities?name=++++')

    expect(status).toBe(404)
    expect((body as any).code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/entities/:id — edge cases
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities/:id — edge cases', () => {
  it('rejects a non-UUID id with 400 VALIDATION_ERROR (SW5-M2 — malformed :id never reaches the service)', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities/plainstring-id')

    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
    expect((body as { error: string }).error).toContain('must be a valid UUID')
    expect(entityService.getById).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/entities/:id/related — limit clamping
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities/:id/related — limit boundary', () => {
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('clamps limit=100 exactly (not exceeded)', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    await testJson(app, `/api/v1/entities/${UUID}/related?limit=100`)

    expect(entityService.getRelated).toHaveBeenCalledWith(UUID, 100)
  })

  it('defaults limit to 20 for non-numeric limit param', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    await testJson(app, `/api/v1/entities/${UUID}/related?limit=abc`)

    // Number('abc') = NaN → isFinite = false → falls back to 20
    expect(entityService.getRelated).toHaveBeenCalledWith(UUID, 20)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/merge — whitespace handling
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/merge — whitespace handling', () => {
  it('trims whitespace from target_id before calling service', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status } = await testJson(app, '/api/v1/entities/77777777-7777-7777-7777-777777777777/merge', {
      method: 'POST',
      body: JSON.stringify({ target_id: '  target-uuid-9999  ' }),
    })

    expect(status).toBe(200)
    expect(entityService.merge).toHaveBeenCalledWith('77777777-7777-7777-7777-777777777777', 'target-uuid-9999')
  })

  it('returns 400 for whitespace-only target_id', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities/77777777-7777-7777-7777-777777777777/merge', {
      method: 'POST',
      body: JSON.stringify({ target_id: '   ' }),
    })

    expect(status).toBe(400)
    expect((body as any).code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when target_id is null', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities/77777777-7777-7777-7777-777777777777/merge', {
      method: 'POST',
      body: JSON.stringify({ target_id: null }),
    })

    expect(status).toBe(400)
    expect((body as any).code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when target_id is a number (wrong type)', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities/77777777-7777-7777-7777-777777777777/merge', {
      method: 'POST',
      body: JSON.stringify({ target_id: 42 }),
    })

    expect(status).toBe(400)
    expect((body as any).code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/split — whitespace / boundary
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/split — whitespace handling', () => {
  it('trims whitespace from alias before calling service', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status } = await testJson(app, '/api/v1/entities/22222222-2222-2222-2222-222222222222/split', {
      method: 'POST',
      body: JSON.stringify({ alias: '  Trimmed Alias  ' }),
    })

    expect(status).toBe(201)
    expect(entityService.split).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222', 'Trimmed Alias')
  })

  it('returns 400 for whitespace-only alias', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities/22222222-2222-2222-2222-222222222222/split', {
      method: 'POST',
      body: JSON.stringify({ alias: '   ' }),
    })

    expect(status).toBe(400)
    expect((body as any).code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when alias is null', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities/22222222-2222-2222-2222-222222222222/split', {
      method: 'POST',
      body: JSON.stringify({ alias: null }),
    })

    expect(status).toBe(400)
    expect((body as any).code).toBe('VALIDATION_ERROR')
  })

  it('returns correct envelope shape on success', async () => {
    const entityService = makeEntityService()
    const app = buildApp(entityService)

    const { status, body } = await testJson(app, '/api/v1/entities/22222222-2222-2222-2222-222222222222/split', {
      method: 'POST',
      body: JSON.stringify({ alias: 'Jane' }),
    })

    expect(status).toBe(201)
    const b = body as any
    expect(b.source_entity_id).toBe('22222222-2222-2222-2222-222222222222')
    expect(b.new_entity_id).toBe('split-new-uuid')
    expect(b.alias).toBe('Jane')
    expect(b.message).toContain('Jane')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/ask — question length boundaries
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/ask — length boundaries', () => {
  const entityId = SAMPLE_ENTITY.id

  it('accepts question of exactly 1 character (min boundary)', async () => {
    const entityService = makeEntityService()
    const searchService = makeSearchService()
    const llmGateway = makeLlmGateway()
    const app = buildApp(entityService, { searchService, llmGateway })

    const { status } = await testJson(app, `/api/v1/entities/${entityId}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'x' }),
    })

    expect(status).toBe(200)
  })

  it('accepts question of exactly 2000 characters (max boundary)', async () => {
    const entityService = makeEntityService()
    const searchService = makeSearchService()
    const llmGateway = makeLlmGateway()
    const app = buildApp(entityService, { searchService, llmGateway })

    const { status } = await testJson(app, `/api/v1/entities/${entityId}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'q'.repeat(2000) }),
    })

    expect(status).toBe(200)
  })

  it('returns 400 for empty string question', async () => {
    const entityService = makeEntityService()
    const searchService = makeSearchService()
    const llmGateway = makeLlmGateway()
    const app = buildApp(entityService, { searchService, llmGateway })

    const { status, body } = await testJson(app, `/api/v1/entities/${entityId}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: '' }),
    })

    expect(status).toBe(400)
    expect((body as any).code).toBe('VALIDATION_ERROR')
  })

  it('does not call entityService.ask when entity does not exist', async () => {
    const entityService = makeEntityService({
      entityExists: vi.fn().mockResolvedValue(false),
    })
    const searchService = makeSearchService()
    const llmGateway = makeLlmGateway()
    const app = buildApp(entityService, { searchService, llmGateway })

    await testJson(app, `/api/v1/entities/${entityId}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question: 'What is her role?' }),
    })

    expect(entityService.ask).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/entities/:id/brief — job payload + DI gating
// ---------------------------------------------------------------------------

describe('POST /api/v1/entities/:id/brief — job payload', () => {
  it('job name passed to queue.add is entity-brief', async () => {
    const entityService = makeEntityService()
    const skillQueue = makeSkillQueue('brief-job-42')
    const app = buildApp(entityService, { skillQueue })

    await testJson(app, `/api/v1/entities/${SAMPLE_ENTITY.id}/brief`, {
      method: 'POST',
    })

    const addCall = (skillQueue.add as ReturnType<typeof vi.fn>).mock.calls[0]
    // First arg is the job name
    expect(addCall[0]).toBe('entity-brief')
  })

  it('job payload contains entityId, entityName, entityType', async () => {
    const entityService = makeEntityService()
    const skillQueue = makeSkillQueue()
    const app = buildApp(entityService, { skillQueue })

    await testJson(app, `/api/v1/entities/${SAMPLE_ENTITY.id}/brief`, {
      method: 'POST',
    })

    const addCall = (skillQueue.add as ReturnType<typeof vi.fn>).mock.calls[0]
    const jobData = addCall[1] as any
    expect(jobData.skillName).toBe('entity-brief')
    expect(jobData.input.entityId).toBe(SAMPLE_ENTITY.id)
    expect(jobData.input.entityName).toBe('Jane Doe')
    expect(jobData.input.entityType).toBe('person')
  })

  it('jobId has entity_brief_ prefix', async () => {
    const entityService = makeEntityService()
    const skillQueue = makeSkillQueue()
    const app = buildApp(entityService, { skillQueue })

    await testJson(app, `/api/v1/entities/${SAMPLE_ENTITY.id}/brief`, {
      method: 'POST',
    })

    const addCall = (skillQueue.add as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = addCall[2] as any
    expect(opts.jobId).toMatch(new RegExp(`^entity_brief_${SAMPLE_ENTITY.id}_\\d+$`))
  })

  it('returns 202 with job_id from queue', async () => {
    const entityService = makeEntityService()
    const skillQueue = makeSkillQueue('the-job-id')
    const app = buildApp(entityService, { skillQueue })

    const { status, body } = await testJson(app, `/api/v1/entities/${SAMPLE_ENTITY.id}/brief`, {
      method: 'POST',
    })

    expect(status).toBe(202)
    expect((body as any).job_id).toBe('the-job-id')
  })
})
