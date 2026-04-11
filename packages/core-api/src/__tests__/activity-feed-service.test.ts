import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ActivityFeedService } from '../services/activity-feed.js'

// ---------------------------------------------------------------------------
// Mock pg-notify (must be before service import uses it)
// ---------------------------------------------------------------------------
vi.mock('../lib/pg-notify.js', () => ({
  pgNotify: {
    notify: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActivityRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    type: 'capture',
    subtype: 'created',
    timestamp: new Date('2026-04-10T12:00:00Z'),
    summary: 'New idea from api: test content',
    view: 'technical',
    detail: { capture_type: 'idea', source: 'api' },
    source_id: 'cap-1',
    created_at: new Date('2026-04-10T12:00:00Z'),
    ...overrides,
  }
}

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  const terminal = Promise.resolve(rows)
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(chain)
  chain.offset = vi.fn().mockReturnValue(terminal)
  ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal.then(resolve, reject)
  ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
  return chain
}

function insertChain(rows: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnValue(undefined as any),
    returning: vi.fn().mockResolvedValue(rows),
  }
  chain.values.mockReturnValue(chain)
  return chain
}

function buildMockDb() {
  return {
    select: vi.fn(),
    insert: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityFeedService', () => {
  let db: ReturnType<typeof buildMockDb>
  let service: ActivityFeedService

  beforeEach(() => {
    vi.clearAllMocks()
    db = buildMockDb()
    service = new ActivityFeedService(db as any)
  })

  describe('insert()', () => {
    it('inserts an activity entry and returns it', async () => {
      const record = makeActivityRecord()
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      const result = await service.insert({
        type: 'capture',
        subtype: 'created',
        summary: 'New idea from api: test content',
        view: 'technical',
        detail: { capture_type: 'idea', source: 'api' },
        source_id: 'cap-1',
      })

      expect(result).toEqual(record)
      expect(db.insert).toHaveBeenCalled()
      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'capture',
          subtype: 'created',
          summary: 'New idea from api: test content',
          view: 'technical',
          source_id: 'cap-1',
        }),
      )
    })

    it('defaults optional fields to null', async () => {
      const record = makeActivityRecord({ subtype: null, view: null, detail: null, source_id: null })
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      await service.insert({ type: 'system', summary: 'System event' })

      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'system',
          subtype: null,
          view: null,
          detail: null,
          source_id: null,
        }),
      )
    })
  })

  describe('insertCapture()', () => {
    it('creates an activity entry for a new capture', async () => {
      const record = makeActivityRecord()
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      await service.insertCapture({
        id: 'cap-1',
        content: 'My test capture content',
        capture_type: 'idea',
        brain_view: 'technical',
        source: 'api',
      })

      expect(db.insert).toHaveBeenCalled()
      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'capture',
          subtype: 'created',
          view: 'technical',
          source_id: 'cap-1',
        }),
      )
    })

    it('truncates long content in summary', async () => {
      const record = makeActivityRecord()
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      const longContent = 'A'.repeat(200)
      await service.insertCapture({
        id: 'cap-1',
        content: longContent,
        capture_type: 'observation',
        brain_view: 'personal',
        source: 'slack',
      })

      const callArgs = chain.values.mock.calls[0][0]
      expect(callArgs.summary.length).toBeLessThan(200)
      expect(callArgs.summary).toContain('...')
    })

    it('does not throw on insert failure', async () => {
      db.insert.mockImplementation(() => {
        throw new Error('DB error')
      })

      // Should not throw
      await service.insertCapture({
        id: 'cap-1',
        content: 'test',
        capture_type: 'idea',
        brain_view: 'technical',
        source: 'api',
      })
    })
  })

  describe('insertSkill()', () => {
    it('creates an activity entry for a skill completion', async () => {
      const record = makeActivityRecord({ type: 'skill', subtype: 'completed' })
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      await service.insertSkill({
        skill_name: 'weekly-brief',
        duration_ms: 1234,
        output_summary: 'Generated weekly brief',
        skill_log_id: 'sl-1',
      })

      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'skill',
          subtype: 'completed',
          source_id: 'sl-1',
        }),
      )
    })

    it('does not throw on insert failure', async () => {
      db.insert.mockImplementation(() => {
        throw new Error('DB error')
      })

      await service.insertSkill({
        skill_name: 'weekly-brief',
      })
    })
  })

  describe('insertPipeline()', () => {
    it('creates an activity entry for pipeline completion', async () => {
      const record = makeActivityRecord({ type: 'pipeline' })
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      await service.insertPipeline({
        capture_id: 'cap-1',
        stage: 'embed',
        status: 'success',
        duration_ms: 450,
      })

      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pipeline',
          subtype: 'embed:success',
          source_id: 'cap-1',
        }),
      )
    })

    it('includes error in summary for failures', async () => {
      const record = makeActivityRecord({ type: 'pipeline' })
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      await service.insertPipeline({
        capture_id: 'cap-1',
        stage: 'embed',
        status: 'failed',
        error: 'Embedding service unavailable',
      })

      const callArgs = chain.values.mock.calls[0][0]
      expect(callArgs.summary).toContain('failed')
      expect(callArgs.summary).toContain('Embedding service unavailable')
    })
  })

  describe('insertEntity()', () => {
    it('creates an activity entry for entity changes', async () => {
      const record = makeActivityRecord({ type: 'entity' })
      const chain = insertChain([record])
      db.insert.mockReturnValue(chain)

      await service.insertEntity({
        entity_id: 'ent-1',
        name: 'Kubernetes',
        action: 'created',
      })

      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'entity',
          subtype: 'created',
          source_id: 'ent-1',
        }),
      )
    })
  })

  describe('list()', () => {
    it('returns paginated results with no filters', async () => {
      const items = [makeActivityRecord(), makeActivityRecord({ id: 'act-2' })]
      const itemsChain = selectChain(items)
      const countChain = selectChain([{ count: '2' }])

      db.select
        .mockReturnValueOnce(itemsChain)
        .mockReturnValueOnce(countChain)

      const result = await service.list()

      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('applies type filter', async () => {
      const itemsChain = selectChain([])
      const countChain = selectChain([{ count: '0' }])

      db.select
        .mockReturnValueOnce(itemsChain)
        .mockReturnValueOnce(countChain)

      await service.list({ type: 'capture' })

      // where() should have been called with conditions including type filter
      expect(itemsChain.where).toHaveBeenCalled()
    })

    it('applies view filter', async () => {
      const itemsChain = selectChain([])
      const countChain = selectChain([{ count: '0' }])

      db.select
        .mockReturnValueOnce(itemsChain)
        .mockReturnValueOnce(countChain)

      await service.list({ view: 'technical' })

      expect(itemsChain.where).toHaveBeenCalled()
    })

    it('applies since filter', async () => {
      const itemsChain = selectChain([])
      const countChain = selectChain([{ count: '0' }])

      db.select
        .mockReturnValueOnce(itemsChain)
        .mockReturnValueOnce(countChain)

      await service.list({ since: new Date('2026-04-01') })

      expect(itemsChain.where).toHaveBeenCalled()
    })

    it('respects limit and offset', async () => {
      const itemsChain = selectChain([])
      const countChain = selectChain([{ count: '0' }])

      db.select
        .mockReturnValueOnce(itemsChain)
        .mockReturnValueOnce(countChain)

      await service.list({}, 10, 20)

      expect(itemsChain.limit).toHaveBeenCalledWith(10)
      expect(itemsChain.offset).toHaveBeenCalledWith(20)
    })
  })
})
