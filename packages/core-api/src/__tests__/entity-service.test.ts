import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EntityService } from '../services/entity.js'
import { NotFoundError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeEntityRow(overrides: Record<string, unknown> = {}) {
  const d = new Date('2026-04-01T00:00:00Z')
  return {
    id: 'ent-1',
    name: 'Acme Corp',
    entity_type: 'organization',
    canonical_name: 'acme corp',
    aliases: ['Acme'],
    metadata: {},
    mention_count: 5,
    first_seen_at: d,
    last_seen_at: d,
    created_at: d,
    updated_at: d,
    ...overrides,
  }
}

function makeLinkedCaptureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-1',
    content: 'Something about Acme',
    capture_type: 'observation',
    brain_view: 'work-internal',
    relationship: 'mentions',
    confidence: 0.9,
    created_at: new Date('2026-04-02T00:00:00Z'),
    ...overrides,
  }
}

function makeSearchResult(id: string, overrides: Record<string, unknown> = {}) {
  return {
    capture: {
      id,
      content: `content for ${id}`,
      capture_type: 'idea',
      brain_view: 'technical',
      created_at: '2026-04-03T00:00:00Z',
      ...overrides,
    },
    score: 0.8,
  }
}

// ---------------------------------------------------------------------------
// Generalized fluent Drizzle mock (see briefs-service.test.ts for rationale)
// ---------------------------------------------------------------------------
function makeDb(queue: unknown[][]) {
  function chain(result: unknown[]) {
    const terminal = Promise.resolve(result)
    const c: Record<string, unknown> = {}
    for (const m of [
      'from', 'leftJoin', 'innerJoin', 'where', 'groupBy', 'orderBy',
      'limit', 'offset', 'set', 'values',
    ]) {
      c[m] = vi.fn().mockReturnValue(c)
    }
    c.returning = vi.fn().mockResolvedValue(result)
    ;(c as any).then = (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      terminal.then(res, rej)
    ;(c as any).catch = (rej: (e: unknown) => void) => terminal.catch(rej)
    return c
  }
  return {
    select: vi.fn(() => chain(queue.shift() ?? [])),
    insert: vi.fn(() => chain(queue.shift() ?? [])),
    update: vi.fn(() => chain(queue.shift() ?? [])),
    execute: vi.fn(async () => ({ rows: queue.shift() ?? [] })),
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EntityService.list', () => {
  it('returns items + total sorted by mention_count (default)', async () => {
    const db = makeDb([[makeEntityRow()], [{ total: '1' }]])
    const svc = new EntityService(db)

    const result = await svc.list()

    expect(result.total).toBe(1)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('ent-1')
  })

  it('supports sort_by last_seen and a type filter', async () => {
    const db = makeDb([[makeEntityRow()], [{ total: '1' }]])
    const svc = new EntityService(db)

    const result = await svc.list({ sort_by: 'last_seen', type_filter: 'organization', limit: 5, offset: 2 })

    expect(result.total).toBe(1)
  })

  it('supports sort_by name', async () => {
    const db = makeDb([[makeEntityRow()], [{ total: '0' }]])
    const svc = new EntityService(db)

    const result = await svc.list({ sort_by: 'name' })

    expect(result.total).toBe(0)
  })
})

describe('EntityService.getById', () => {
  it('returns entity detail with recent linked captures', async () => {
    const db = makeDb([[makeEntityRow()], [makeLinkedCaptureRow()]])
    const svc = new EntityService(db)

    const detail = await svc.getById('ent-1')

    expect(detail.id).toBe('ent-1')
    expect(detail.linked_captures).toHaveLength(1)
    expect(detail.linked_captures[0].id).toBe('cap-1')
  })

  it('throws NotFoundError when the entity does not exist', async () => {
    const db = makeDb([[]])
    const svc = new EntityService(db)

    await expect(svc.getById('missing')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('EntityService.getByName', () => {
  it('returns the matching entity', async () => {
    const db = makeDb([[makeEntityRow()]])
    const svc = new EntityService(db)

    const found = await svc.getByName('acme corp')

    expect(found?.id).toBe('ent-1')
  })

  it('returns null when no entity matches', async () => {
    const db = makeDb([[]])
    const svc = new EntityService(db)

    expect(await svc.getByName('nobody')).toBeNull()
  })
})

describe('EntityService.merge / split', () => {
  it('merge delegates to the resolution service', async () => {
    const merged = makeEntityRow({ id: 'target' })
    const resolution = { merge: vi.fn().mockResolvedValue(merged), split: vi.fn() }
    const svc = new EntityService(makeDb([]), resolution as any)

    const out = await svc.merge('source', 'target')

    expect(out.id).toBe('target')
    expect(resolution.merge).toHaveBeenCalledWith('source', 'target')
  })

  it('merge throws when resolution service is not configured', async () => {
    const svc = new EntityService(makeDb([]))
    await expect(svc.merge('a', 'b')).rejects.toThrow(/EntityResolutionService/)
  })

  it('split delegates to the resolution service', async () => {
    const resolution = { merge: vi.fn(), split: vi.fn().mockResolvedValue({ new_entity_id: 'ent-2' }) }
    const svc = new EntityService(makeDb([]), resolution as any)

    const out = await svc.split('ent-1', 'Acme')

    expect(out).toEqual({ new_entity_id: 'ent-2' })
    expect(resolution.split).toHaveBeenCalledWith('ent-1', 'Acme')
  })

  it('split throws when resolution service is not configured', async () => {
    const svc = new EntityService(makeDb([]))
    await expect(svc.split('ent-1', 'Acme')).rejects.toThrow(/EntityResolutionService/)
  })
})

describe('EntityService.entityExists', () => {
  it('returns true when a row exists', async () => {
    const svc = new EntityService(makeDb([[{ one: 1 }]]))
    expect(await svc.entityExists('ent-1')).toBe(true)
  })

  it('returns false when no row exists', async () => {
    const svc = new EntityService(makeDb([[]]))
    expect(await svc.entityExists('missing')).toBe(false)
  })
})

describe('EntityService.getRelated', () => {
  it('returns related entities from the raw two-hop query', async () => {
    const rows = [{ id: 'ent-2', name: 'Beta', type: 'organization', shared_count: 3 }]
    const svc = new EntityService(makeDb([rows]))

    const related = await svc.getRelated('ent-1', 10)

    expect(related).toHaveLength(1)
    expect(related[0].shared_count).toBe(3)
  })
})

describe('EntityService.getMentionsTimeline', () => {
  it('returns non-zero time buckets', async () => {
    const rows = [{ period: '2026-04-01', count: 4 }]
    const svc = new EntityService(makeDb([rows]))

    const timeline = await svc.getMentionsTimeline('ent-1', '30d', 'day')

    expect(timeline).toEqual(rows)
  })
})

describe('EntityService.recordMention', () => {
  it('issues an update without throwing', async () => {
    const db = makeDb([[]])
    const svc = new EntityService(db)

    await expect(svc.recordMention('ent-1')).resolves.toBeUndefined()
    expect(db.update).toHaveBeenCalledTimes(1)
  })
})

describe('EntityService.ask', () => {
  const entityMetaRow = { id: 'ent-1', name: 'Acme Corp', entity_type: 'organization' }

  it('throws NotFoundError when the entity does not exist', async () => {
    const db = makeDb([[]])
    const svc = new EntityService(db)
    const searchService = { search: vi.fn() }
    const llm = { completeByTask: vi.fn() }

    await expect(
      svc.ask('missing', 'q?', searchService as any, llm as any),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns the empty-brain response when the entity has no linked captures', async () => {
    const db = makeDb([[entityMetaRow], []]) // meta found, no links
    const svc = new EntityService(db)
    const searchService = { search: vi.fn() }
    const llm = { completeByTask: vi.fn() }

    const out = await svc.ask('ent-1', 'q?', searchService as any, llm as any)

    expect(out.capture_count).toBe(0)
    expect(out.response).toMatch(/couldn't find/i)
    expect(searchService.search).not.toHaveBeenCalled()
  })

  it('synthesizes an answer from the hybrid-search intersection (happy path)', async () => {
    const linked = [
      { capture_id: 'c1' }, { capture_id: 'c2' }, { capture_id: 'c3' }, { capture_id: 'c4' },
    ]
    const db = makeDb([[entityMetaRow], linked])
    const svc = new EntityService(db)
    const searchService = {
      search: vi.fn().mockResolvedValue([
        makeSearchResult('c1'), makeSearchResult('c2'), makeSearchResult('c3'),
      ]),
    }
    const llm = { completeByTask: vi.fn().mockResolvedValue('  The answer.  ') }

    const out = await svc.ask('ent-1', 'What about Acme?', searchService as any, llm as any)

    expect(out.response).toBe('The answer.')
    expect(out.capture_count).toBe(3)
    expect(out.entity).toEqual({ id: 'ent-1', name: 'Acme Corp', type: 'organization' })
    // Only one search call needed — intersection already >= 3
    expect(searchService.search).toHaveBeenCalledTimes(1)
    expect(llm.completeByTask).toHaveBeenCalledWith(
      expect.stringContaining('Acme Corp'),
      'search_synthesis',
      expect.objectContaining({ maxTokens: 1024 }),
    )
  })

  it('falls back to FTS when the hybrid search throws', async () => {
    const linked = [{ capture_id: 'c1' }, { capture_id: 'c2' }, { capture_id: 'c3' }]
    const db = makeDb([[entityMetaRow], linked])
    const svc = new EntityService(db)
    const search = vi.fn()
      .mockRejectedValueOnce(new Error('embedding down')) // hybrid attempt
      .mockResolvedValueOnce([makeSearchResult('c1'), makeSearchResult('c2'), makeSearchResult('c3')])
    const searchService = { search }
    const llm = { completeByTask: vi.fn().mockResolvedValue('answer') }

    const out = await svc.ask('ent-1', 'q?', searchService as any, llm as any)

    expect(out.capture_count).toBe(3)
    expect(search).toHaveBeenCalledTimes(2)
    // Second call used the fts fallback mode
    expect(search.mock.calls[1][1]).toMatchObject({ searchMode: 'fts' })
  })

  it('widens with an FTS fallback when the intersection is < 3', async () => {
    const linked = [
      { capture_id: 'c1' }, { capture_id: 'c2' }, { capture_id: 'c3' }, { capture_id: 'c4' },
    ]
    const db = makeDb([[entityMetaRow], linked])
    const svc = new EntityService(db)
    const search = vi.fn()
      .mockResolvedValueOnce([makeSearchResult('c1')]) // hybrid: only 1 in-set
      .mockResolvedValueOnce([makeSearchResult('c2'), makeSearchResult('c3')]) // fts widen
    const searchService = { search }
    const llm = { completeByTask: vi.fn().mockResolvedValue('answer') }

    const out = await svc.ask('ent-1', 'q?', searchService as any, llm as any)

    expect(search).toHaveBeenCalledTimes(2)
    expect(out.capture_count).toBe(3) // 1 + 2 deduped
  })

  it('returns the empty-brain response when nothing intersects even after fallback', async () => {
    const linked = [{ capture_id: 'c1' }]
    const db = makeDb([[entityMetaRow], linked])
    const svc = new EntityService(db)
    const search = vi.fn()
      .mockResolvedValueOnce([makeSearchResult('zzz')]) // hybrid: no in-set match
      .mockResolvedValueOnce([makeSearchResult('yyy')]) // fts: still none
    const searchService = { search }
    const llm = { completeByTask: vi.fn() }

    const out = await svc.ask('ent-1', 'q?', searchService as any, llm as any)

    expect(out.capture_count).toBe(0)
    expect(out.response).toMatch(/couldn't find/i)
    expect(llm.completeByTask).not.toHaveBeenCalled()
  })
})
