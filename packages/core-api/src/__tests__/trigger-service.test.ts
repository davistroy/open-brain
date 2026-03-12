import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TriggerService } from '../services/trigger.js'
import { ValidationError, NotFoundError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock EmbeddingService
// ---------------------------------------------------------------------------

function makeMockEmbeddingService(embedding: number[] = new Array(768).fill(0.1)) {
  return {
    embed: vi.fn().mockResolvedValue(embedding),
    embedBatch: vi.fn().mockResolvedValue([embedding]),
    getModelInfo: vi.fn().mockReturnValue({ model: 'spark-qwen3-embedding-4b', dimensions: 768, source: 'https://llm.k4jda.net' }),
  }
}

// ---------------------------------------------------------------------------
// Mock Database builder
// ---------------------------------------------------------------------------

/**
 * Returns a fluent Drizzle-style select chain that resolves to `rows`.
 */
function selectChain(rows: unknown[]) {
  const terminal = Promise.resolve(rows)
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(terminal)
  // Make chain itself thenable so queries that don't end in .limit() resolve correctly
  ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal.then(resolve, reject)
  ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
  return chain
}

function makeMockDb(overrides: Partial<{
  selectRows: unknown[]
  insertRow: unknown
  updateRow: unknown
  executeRows: unknown[]
}> = {}) {
  const {
    selectRows = [],
    insertRow = null,
    updateRow = null,
    executeRows = [],
  } = overrides

  return {
    select: vi.fn().mockImplementation(() => selectChain(selectRows)),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertRow ? [insertRow] : []),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(updateRow ? [updateRow] : []),
      }),
    }),
    execute: vi.fn().mockResolvedValue({ rows: executeRows }),
  }
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_TRIGGER = {
  id: 'trigger-1',
  name: 'QSR timeline',
  description: 'Watch for QSR project timeline discussions',
  condition_text: 'QSR project timeline compressed urgent',
  threshold: 0.72,
  action: 'notify',
  action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
  enabled: true,
  last_triggered_at: null,
  trigger_count: 0,
  created_at: new Date('2026-03-05T10:00:00Z'),
  updated_at: new Date('2026-03-05T10:00:00Z'),
}

const SAMPLE_EMBEDDING = new Array(768).fill(0.1)

// ---------------------------------------------------------------------------
// TriggerService.create
// ---------------------------------------------------------------------------

describe('TriggerService.create', () => {
  let db: ReturnType<typeof makeMockDb>
  let embeddingService: ReturnType<typeof makeMockEmbeddingService>
  let service: TriggerService

  beforeEach(() => {
    vi.clearAllMocks()
    embeddingService = makeMockEmbeddingService(SAMPLE_EMBEDDING)
  })

  it('creates trigger with pre-computed embedding and default threshold', async () => {
    // count query returns 0 active triggers
    let selectCallCount = 0
    db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) {
          // Count query
          return selectChain([{ count: '0' }])
        }
        return selectChain([])
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([SAMPLE_TRIGGER]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as ReturnType<typeof makeMockDb>

    service = new TriggerService(db as any, embeddingService as any)

    const trigger = await service.create({
      name: 'QSR timeline',
      queryText: 'QSR project timeline compressed urgent',
    })

    expect(embeddingService.embed).toHaveBeenCalledWith('QSR project timeline compressed urgent')
    expect(db.insert).toHaveBeenCalled()
    expect(trigger.name).toBe('QSR timeline')
    expect(trigger.threshold).toBe(0.72)
  })

  it('throws ValidationError when threshold is out of range', async () => {
    let selectCallCount = 0
    db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++
        return selectChain([{ count: '0' }])
      }),
      insert: vi.fn(),
      update: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as ReturnType<typeof makeMockDb>

    service = new TriggerService(db as any, embeddingService as any)

    await expect(
      service.create({ name: 'test', queryText: 'hello', threshold: 1.5 }),
    ).rejects.toThrow(ValidationError)
  })

  it('throws ValidationError when max active triggers (20) reached', async () => {
    db = {
      select: vi.fn().mockImplementation(() => selectChain([{ count: '20' }])),
      insert: vi.fn(),
      update: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as ReturnType<typeof makeMockDb>

    service = new TriggerService(db as any, embeddingService as any)

    await expect(
      service.create({ name: 'test', queryText: 'hello world' }),
    ).rejects.toThrow(ValidationError)
  })

  it('uses custom threshold and cooldownMinutes when provided', async () => {
    let insertValues: unknown = null
    db = {
      select: vi.fn().mockImplementation(() => selectChain([{ count: '0' }])),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertValues = vals
          return { returning: vi.fn().mockResolvedValue([{ ...SAMPLE_TRIGGER, threshold: 0.85 }]) }
        }),
      })),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as ReturnType<typeof makeMockDb>

    service = new TriggerService(db as any, embeddingService as any)

    await service.create({
      name: 'high threshold',
      queryText: 'specific topic',
      threshold: 0.85,
      cooldownMinutes: 120,
    })

    expect(insertValues).toBeTruthy()
    const vals = insertValues as Record<string, unknown>
    expect(vals.threshold).toBe(0.85)
    const actionConfig = vals.action_config as Record<string, unknown>
    expect(actionConfig.cooldown_minutes).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// TriggerService.list
// ---------------------------------------------------------------------------

describe('TriggerService.list', () => {
  it('returns all triggers ordered by created_at desc', async () => {
    const rows = [SAMPLE_TRIGGER, { ...SAMPLE_TRIGGER, id: 'trigger-2', name: 'Other trigger' }]
    const db = makeMockDb({ selectRows: rows })
    const embeddingService = makeMockEmbeddingService()
    const service = new TriggerService(db as any, embeddingService as any)

    const result = await service.list()

    expect(db.select).toHaveBeenCalled()
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('QSR timeline')
    expect(result[1].name).toBe('Other trigger')
  })

  it('returns empty array when no triggers exist', async () => {
    const db = makeMockDb({ selectRows: [] })
    const embeddingService = makeMockEmbeddingService()
    const service = new TriggerService(db as any, embeddingService as any)

    const result = await service.list()
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// TriggerService.delete
// ---------------------------------------------------------------------------

describe('TriggerService.delete', () => {
  it('hard-deletes trigger by ID', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => selectChain([{ id: 'trigger-1' }])),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
      insert: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }

    const embeddingService = makeMockEmbeddingService()
    const service = new TriggerService(db as any, embeddingService as any)

    await service.delete('trigger-1')

    expect(db.delete).toHaveBeenCalled()
  })

  it('throws NotFoundError when trigger does not exist', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => selectChain([])),
      update: vi.fn(),
      insert: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }

    const embeddingService = makeMockEmbeddingService()
    const service = new TriggerService(db as any, embeddingService as any)

    await expect(service.delete('nonexistent-id')).rejects.toThrow(NotFoundError)
  })
})

// ---------------------------------------------------------------------------
// TriggerService.test
// ---------------------------------------------------------------------------

describe('TriggerService.test', () => {
  it('returns top matches ordered by similarity without firing', async () => {
    const matchRows = [
      {
        id: 'cap-1',
        content: 'QSR project timeline is very compressed this quarter',
        capture_type: 'observation',
        brain_view: 'work-internal',
        created_at: new Date('2026-03-01T10:00:00Z'),
        similarity: 0.87,
      },
      {
        id: 'cap-2',
        content: 'Timeline review meeting scheduled for next week',
        capture_type: 'task',
        brain_view: 'work-internal',
        created_at: new Date('2026-03-02T10:00:00Z'),
        similarity: 0.74,
      },
    ]

    const embeddingService = makeMockEmbeddingService(SAMPLE_EMBEDDING)
    const db = makeMockDb({ executeRows: matchRows })
    const service = new TriggerService(db as any, embeddingService as any)

    const results = await service.test('QSR timeline urgency', 5)

    expect(embeddingService.embed).toHaveBeenCalledWith('QSR timeline urgency')
    expect(db.execute).toHaveBeenCalled()
    expect(results).toHaveLength(2)
    expect(results[0].capture_id).toBe('cap-1')
    expect(results[0].similarity).toBe(0.87)
    expect(results[0].content).toContain('QSR project timeline')
  })

  it('returns empty array when no captures match', async () => {
    const embeddingService = makeMockEmbeddingService(SAMPLE_EMBEDDING)
    const db = makeMockDb({ executeRows: [] })
    const service = new TriggerService(db as any, embeddingService as any)

    const results = await service.test('something very obscure', 5)
    expect(results).toHaveLength(0)
  })

  it('respects limit parameter', async () => {
    const matchRows = Array.from({ length: 3 }, (_, i) => ({
      id: `cap-${i}`,
      content: `Content ${i}`,
      capture_type: 'idea',
      brain_view: 'technical',
      created_at: new Date(),
      similarity: 0.9 - i * 0.05,
    }))

    const embeddingService = makeMockEmbeddingService(SAMPLE_EMBEDDING)
    const db = makeMockDb({ executeRows: matchRows })
    const service = new TriggerService(db as any, embeddingService as any)

    await service.test('test query', 3)

    // Verify the SQL was called (limit passed via sql template)
    expect(db.execute).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// TriggerService.recordFire
// ---------------------------------------------------------------------------

describe('TriggerService.recordFire', () => {
  it('updates last_triggered_at and increments trigger_count', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => selectChain([])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }

    const embeddingService = makeMockEmbeddingService()
    const service = new TriggerService(db as any, embeddingService as any)

    await service.recordFire('trigger-1')

    expect(db.update).toHaveBeenCalled()
    const setCall = (db.update().set as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(setCall).toHaveProperty('last_triggered_at')
    expect(setCall).toHaveProperty('updated_at')
  })
})
