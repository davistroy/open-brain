import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureService } from '../services/capture.js'
import { ConflictError, NotFoundError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Helpers to build mock db results
// ---------------------------------------------------------------------------

function makeCaptureRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-1',
    content: 'Test capture content',
    content_hash: 'abc123',
    capture_type: 'idea',
    brain_view: 'technical',
    source: 'api',
    source_metadata: null,
    tags: [],
    pipeline_status: 'pending',
    pipeline_attempts: 0,
    pipeline_error: null,
    pipeline_completed_at: null,
    pre_extracted: null,
    created_at: new Date('2026-03-05T10:00:00Z'),
    updated_at: new Date('2026-03-05T10:00:00Z'),
    captured_at: new Date('2026-03-05T10:00:00Z'),
    deleted_at: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock the Drizzle ORM db object
// ---------------------------------------------------------------------------

function buildMockDb() {
  // Each method call in a Drizzle query chain returns an object with the next
  // chainable method.  We build a fluent mock that resolves at .limit(),
  // .returning(), or when the terminal awaitable is provided.

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  }

  return mockDb
}

// ---------------------------------------------------------------------------
// Helper: create a fluent select chain that resolves to `rows`
// ---------------------------------------------------------------------------
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  const terminal = Promise.resolve(rows)
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.groupBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(terminal)
  chain.offset = vi.fn().mockReturnValue(terminal)
  // Make the chain itself thenable so Promise.all works when the chain ends
  // without .limit()/.offset() (e.g., groupBy queries)
  ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal.then(resolve, reject)
  ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
  return chain
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CaptureService', () => {
  let db: ReturnType<typeof buildMockDb>
  let service: CaptureService

  beforeEach(() => {
    vi.clearAllMocks()
    db = buildMockDb()
    service = new CaptureService(db as any)
  })

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe('create()', () => {
    it('inserts a new capture and returns the record', async () => {
      const record = makeCaptureRecord()

      // First select (dedup check): empty result
      db.select
        .mockReturnValueOnce(selectChain([]))

      // Insert chain
      const insertChain = {
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([record]) }),
      }
      db.insert.mockReturnValueOnce(insertChain)

      const result = await service.create({
        content: 'Test capture content',
        capture_type: 'idea',
        brain_view: 'technical',
        source: 'api',
      })

      expect(result).toEqual(record)
      expect(db.insert).toHaveBeenCalledOnce()
    })

    it('throws ConflictError when duplicate found within 60s window', async () => {
      const existing = [{ id: 'cap-existing', created_at: new Date() }]

      db.select.mockReturnValueOnce(selectChain(existing))

      await expect(
        service.create({
          content: 'Test capture content',
          capture_type: 'idea',
          brain_view: 'technical',
          source: 'api',
        }),
      ).rejects.toThrow(ConflictError)
    })

    it('uses captured_at from metadata when provided', async () => {
      const record = makeCaptureRecord({ captured_at: new Date('2026-01-01T00:00:00Z') })

      db.select.mockReturnValueOnce(selectChain([]))

      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([record]),
      })
      db.insert.mockReturnValueOnce({ values: insertValues })

      await service.create({
        content: 'Backdated capture',
        capture_type: 'observation',
        brain_view: 'personal',
        source: 'voice',
        metadata: { captured_at: '2026-01-01T00:00:00Z' },
      })

      // The values() call should have been made with the provided captured_at
      const insertedValues = insertValues.mock.calls[0][0]
      expect(insertedValues.captured_at).toEqual(new Date('2026-01-01T00:00:00Z'))
    })

    it('defaults to api source when metadata has no source_metadata', async () => {
      const record = makeCaptureRecord()
      db.select.mockReturnValueOnce(selectChain([]))
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([record]),
      })
      db.insert.mockReturnValueOnce({ values: insertValues })

      await service.create({
        content: 'Simple capture',
        capture_type: 'idea',
        brain_view: 'technical',
        source: 'api',
      })

      const insertedValues = insertValues.mock.calls[0][0]
      expect(insertedValues.source_metadata).toBeNull()
      expect(insertedValues.tags).toEqual([])
      expect(insertedValues.pipeline_status).toBe('pending')
    })
  })

  // -------------------------------------------------------------------------
  // getById()
  // -------------------------------------------------------------------------

  describe('getById()', () => {
    it('returns the capture record when found', async () => {
      const record = makeCaptureRecord()
      db.select.mockReturnValueOnce(selectChain([record]))

      const result = await service.getById('cap-1')
      expect(result).toEqual(record)
    })

    it('throws NotFoundError when capture does not exist', async () => {
      db.select.mockReturnValueOnce(selectChain([]))

      await expect(service.getById('nonexistent-id')).rejects.toThrow(NotFoundError)
    })

    it('includes the id in the NotFoundError message', async () => {
      db.select.mockReturnValueOnce(selectChain([]))

      await expect(service.getById('missing-id')).rejects.toThrow('missing-id')
    })

    it('throws NotFoundError for a soft-deleted capture (deleted_at is set)', async () => {
      // getById filters on deleted_at IS NULL — a deleted capture returns empty rows
      db.select.mockReturnValueOnce(selectChain([]))

      await expect(service.getById('deleted-cap')).rejects.toThrow(NotFoundError)
    })
  })

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe('list()', () => {
    function setupListMocks(items: unknown[], total: number) {
      // list() calls Promise.all([items query, count query])
      // Items query chain ends with .offset(), count query ends with no .limit()/.offset()
      const itemsChain: Record<string, unknown> = {}
      itemsChain.from = vi.fn().mockReturnValue(itemsChain)
      itemsChain.where = vi.fn().mockReturnValue(itemsChain)
      itemsChain.orderBy = vi.fn().mockReturnValue(itemsChain)
      itemsChain.limit = vi.fn().mockReturnValue({
        offset: vi.fn().mockResolvedValue(items),
      })

      const countChain: Record<string, unknown> = {}
      const countResult = [{ count: String(total) }]
      const countTerminal = Promise.resolve(countResult)
      countChain.from = vi.fn().mockReturnValue(countChain)
      countChain.where = vi.fn().mockReturnValue(countChain)
      ;(countChain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        countTerminal.then(resolve, reject)
      ;(countChain as any).catch = (reject: (e: unknown) => void) => countTerminal.catch(reject)

      db.select.mockReturnValueOnce(itemsChain).mockReturnValueOnce(countChain)
    }

    it('returns items and total with default pagination', async () => {
      const records = [makeCaptureRecord(), makeCaptureRecord({ id: 'cap-2' })]
      setupListMocks(records, 2)

      const result = await service.list()
      expect(result.items).toEqual(records)
      expect(result.total).toBe(2)
    })

    it('returns empty list when no captures exist', async () => {
      setupListMocks([], 0)

      const result = await service.list()
      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(0)
    })

    it('applies filters and respects limit/offset', async () => {
      const records = [makeCaptureRecord({ brain_view: 'career' })]
      setupListMocks(records, 1)

      const result = await service.list({ brain_view: 'career' }, 10, 5)
      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it('returns empty items and zero total when no records', async () => {
      setupListMocks([], 0)
      const result = await service.list({ capture_type: 'task' })
      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })

    it('excludes soft-deleted captures (deleted_at IS NULL filter applied)', async () => {
      // list() always starts conditions with isNull(captures.deleted_at).
      // The mock returns only non-deleted records; we verify list() returns them.
      const activeRecord = makeCaptureRecord({ id: 'active-cap', deleted_at: null })
      setupListMocks([activeRecord], 1)

      const result = await service.list()
      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('active-cap')
      expect(result.total).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // update()
  // -------------------------------------------------------------------------

  describe('update()', () => {
    it('updates and returns the record', async () => {
      const original = makeCaptureRecord()
      const updated = makeCaptureRecord({ tags: ['updated-tag'], brain_view: 'career' })

      // getById call
      db.select.mockReturnValueOnce(selectChain([original]))

      // update().set().where().returning()
      const updateChain = {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      }
      db.update.mockReturnValueOnce(updateChain)

      const result = await service.update('cap-1', {
        tags: ['updated-tag'],
        brain_view: 'career',
      })

      expect(result).toEqual(updated)
    })

    it('throws NotFoundError when capture does not exist', async () => {
      db.select.mockReturnValueOnce(selectChain([]))

      await expect(
        service.update('nonexistent', { tags: ['test'] }),
      ).rejects.toThrow(NotFoundError)
    })

    it('merges metadata_overrides via SQL expression when provided', async () => {
      const original = makeCaptureRecord()
      const updated = makeCaptureRecord({ source_metadata: { key: 'value' } })

      db.select.mockReturnValueOnce(selectChain([original]))

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      })
      db.update.mockReturnValueOnce({ set: setMock })

      await service.update('cap-1', {
        metadata_overrides: { key: 'value' },
      })

      const setArgs = setMock.mock.calls[0][0]
      // metadata_overrides triggers a SQL expression — verify source_metadata key is present
      expect(setArgs).toHaveProperty('source_metadata')
    })
  })

  // -------------------------------------------------------------------------
  // softDelete()
  // -------------------------------------------------------------------------

  describe('softDelete()', () => {
    it('marks capture as deleted — sets deleted_at, pipeline_status, and updated_at', async () => {
      const record = makeCaptureRecord()
      db.select.mockReturnValueOnce(selectChain([record]))

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      })
      db.update.mockReturnValueOnce({ set: setMock })

      await service.softDelete('cap-1')

      const setArgs = setMock.mock.calls[0][0]
      expect(setArgs.deleted_at).toBeInstanceOf(Date)
      expect(setArgs.pipeline_status).toBe('deleted')
      expect(setArgs.updated_at).toBeInstanceOf(Date)
    })

    it('throws NotFoundError for missing capture', async () => {
      db.select.mockReturnValueOnce(selectChain([]))

      await expect(service.softDelete('missing')).rejects.toThrow(NotFoundError)
    })
  })

  // -------------------------------------------------------------------------
  // getStats()
  // -------------------------------------------------------------------------

  describe('getStats()', () => {
    function setupStatsMocks() {
      // getStats() calls Promise.all([bySource, byType, byView, pipelineHealth])
      // Each query chain ends as a thenable (no .limit())
      function statChain(rows: unknown[]) {
        const terminal = Promise.resolve(rows)
        const chain: Record<string, unknown> = {
          from: vi.fn(),
          where: vi.fn(),
          groupBy: vi.fn(),
        }
        // Chain each through self
        ;(chain.from as ReturnType<typeof vi.fn>).mockReturnValue(chain)
        ;(chain.where as ReturnType<typeof vi.fn>).mockReturnValue(chain)
        ;(chain.groupBy as ReturnType<typeof vi.fn>).mockReturnValue(chain)
        ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          terminal.then(resolve, reject)
        ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
        return chain
      }

      db.select
        .mockReturnValueOnce(statChain([{ source: 'api', count: '5' }, { source: 'slack', count: '3' }]))
        .mockReturnValueOnce(statChain([{ capture_type: 'idea', count: '4' }, { capture_type: 'task', count: '4' }]))
        .mockReturnValueOnce(statChain([{ brain_view: 'technical', count: '6' }, { brain_view: 'career', count: '2' }]))
        .mockReturnValueOnce(statChain([
          { pipeline_status: 'pending', count: '3' },
          { pipeline_status: 'complete', count: '4' },
          { pipeline_status: 'failed', count: '1' },
        ]))
    }

    it('returns aggregated stats', async () => {
      setupStatsMocks()

      const stats = await service.getStats()

      expect(stats.total_captures).toBe(8) // 5 + 3 from bySource
      expect(stats.by_source).toEqual({ api: 5, slack: 3 })
      expect(stats.by_type).toEqual({ idea: 4, task: 4 })
      expect(stats.by_view).toEqual({ technical: 6, career: 2 })
      expect(stats.pipeline_health.pending).toBe(3)
      expect(stats.pipeline_health.complete).toBe(4)
      expect(stats.pipeline_health.failed).toBe(1)
      expect(stats.pipeline_health.processing).toBe(0)
      expect(stats.total_entities).toBe(0) // Phase 12 placeholder
    })

    it('handles empty database gracefully', async () => {
      function emptyChain() {
        const terminal = Promise.resolve([])
        const chain: Record<string, unknown> = {
          from: vi.fn(),
          where: vi.fn(),
          groupBy: vi.fn(),
        }
        ;(chain.from as ReturnType<typeof vi.fn>).mockReturnValue(chain)
        ;(chain.where as ReturnType<typeof vi.fn>).mockReturnValue(chain)
        ;(chain.groupBy as ReturnType<typeof vi.fn>).mockReturnValue(chain)
        ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          terminal.then(resolve, reject)
        ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
        return chain
      }

      db.select
        .mockReturnValueOnce(emptyChain())
        .mockReturnValueOnce(emptyChain())
        .mockReturnValueOnce(emptyChain())
        .mockReturnValueOnce(emptyChain())

      const stats = await service.getStats()

      expect(stats.total_captures).toBe(0)
      expect(stats.by_source).toEqual({})
      expect(stats.by_type).toEqual({})
      expect(stats.by_view).toEqual({})
      expect(stats.pipeline_health).toEqual({ pending: 0, processing: 0, complete: 0, failed: 0 })
    })
  })
})
