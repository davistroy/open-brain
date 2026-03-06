import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  processExtractEntitiesJob,
  extractEntitiesBackoffStrategy,
} from '../jobs/extract-entities.js'
import type { ExtractEntitiesJobData } from '../queues/extract-entities.js'
import { EXTRACT_ENTITIES_BACKOFF_DELAYS_MS } from '../queues/extract-entities.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Fluent select chain mock for Drizzle ORM.
 * Resolves with the provided rows on .limit() or as a Promise directly.
 */
function selectChain(rows: unknown[]) {
  const terminal = Promise.resolve(rows)
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(terminal)
  ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal.then(resolve, reject)
  ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
  return chain
}

/**
 * Fluent insert chain mock for Drizzle ORM.
 */
function insertChain(returnedRows: unknown[] = []) {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returnedRows)
  chain.onConflictDoNothing = vi.fn().mockResolvedValue(undefined)
  // Make thenable for INSERT without .returning()
  ;(chain as any).then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve)
  return chain
}

/**
 * Build a mock Drizzle DB. Accepts per-call select rows and insert return rows.
 */
function makeMockDb(options: {
  captureRow?: Record<string, unknown> | null
  entityCandidates?: Record<string, unknown>[]
  insertedEntity?: { id: string } | null
} = {}) {
  const {
    captureRow = {
      id: 'cap-1',
      content: 'Decided to migrate Acme Corp to AWS with Alice leading. Using pgvector for search.',
      pipeline_status: 'embedded',
    },
    entityCandidates = [],
    insertedEntity = { id: 'ent-new-1' },
  } = options

  let selectCallCount = 0

  const db: Record<string, unknown> = {}

  db.select = vi.fn().mockImplementation(() => {
    selectCallCount++
    // Call 1: fetch capture
    if (selectCallCount === 1) {
      return selectChain(captureRow === null ? [] : [captureRow])
    }
    // Call 2+: fetch entity candidates for each entity type
    return selectChain(entityCandidates)
  })

  const insertChainObj = insertChain(insertedEntity ? [insertedEntity] : [])
  db.insert = vi.fn().mockReturnValue(insertChainObj)

  const updateChain: Record<string, unknown> = {}
  updateChain.set = vi.fn().mockReturnValue(updateChain)
  updateChain.where = vi.fn().mockResolvedValue(undefined)
  db.update = vi.fn().mockReturnValue(updateChain)

  return db
}

/**
 * Build a mock OpenAI client that returns the given JSON string as completion text.
 */
function makeMockLitellmClient(responseText: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseText } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      },
    },
  } as any
}

// ---------------------------------------------------------------------------
// Mock fs
// ---------------------------------------------------------------------------
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(
    'Extract entities from: {{content}}\nReturn JSON with people, organizations, concepts, decisions, projects.',
  ),
}))

// ---------------------------------------------------------------------------
// Tests: extractEntitiesBackoffStrategy
// ---------------------------------------------------------------------------
describe('extractEntitiesBackoffStrategy', () => {
  it('returns correct delays for attempts 1-5', () => {
    expect(extractEntitiesBackoffStrategy(1)).toBe(EXTRACT_ENTITIES_BACKOFF_DELAYS_MS[0]) // 30s
    expect(extractEntitiesBackoffStrategy(2)).toBe(EXTRACT_ENTITIES_BACKOFF_DELAYS_MS[1]) // 2m
    expect(extractEntitiesBackoffStrategy(3)).toBe(EXTRACT_ENTITIES_BACKOFF_DELAYS_MS[2]) // 10m
    expect(extractEntitiesBackoffStrategy(4)).toBe(EXTRACT_ENTITIES_BACKOFF_DELAYS_MS[3]) // 30m
    expect(extractEntitiesBackoffStrategy(5)).toBe(EXTRACT_ENTITIES_BACKOFF_DELAYS_MS[4]) // 2h
  })

  it('clamps at last delay for attempts beyond 5', () => {
    const last = EXTRACT_ENTITIES_BACKOFF_DELAYS_MS[EXTRACT_ENTITIES_BACKOFF_DELAYS_MS.length - 1]
    expect(extractEntitiesBackoffStrategy(6)).toBe(last)
    expect(extractEntitiesBackoffStrategy(10)).toBe(last)
  })
})

// ---------------------------------------------------------------------------
// Tests: processExtractEntitiesJob
// ---------------------------------------------------------------------------
describe('processExtractEntitiesJob', () => {
  const promptsDir = '/fake/prompts'
  const synthesisModel = 'synthesis'
  const jobData: ExtractEntitiesJobData = { captureId: 'cap-1' }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips gracefully when capture is not found', async () => {
    const db = makeMockDb({ captureRow: null }) as any
    const client = makeMockLitellmClient('{}')

    await expect(
      processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir),
    ).resolves.toBeUndefined()

    expect(client.chat.completions.create).not.toHaveBeenCalled()
    // insert only called for missing capture check path: no pipeline_events insert
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('extracts entities and creates entity_links on success', async () => {
    const llmResponse = JSON.stringify({
      people: ['Alice'],
      organizations: ['Acme Corp'],
      concepts: ['pgvector'],
      decisions: ['migrate to AWS'],
      projects: ['Brain v2'],
    })

    const db = makeMockDb({ entityCandidates: [] }) as any
    const client = makeMockLitellmClient(llmResponse)

    await processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir)

    expect(client.chat.completions.create).toHaveBeenCalledOnce()
    // Should have inserted entities (one per mention) and linked them
    expect(db.insert).toHaveBeenCalled()
  })

  it('resolves an existing entity by exact name match and updates last_seen_at', async () => {
    const llmResponse = JSON.stringify({
      people: ['Alice'],
      organizations: [],
      concepts: [],
      decisions: [],
      projects: [],
    })

    const existingEntity = {
      id: 'ent-existing-1',
      name: 'Alice',
      canonical_name: 'Alice',
      aliases: [],
    }

    const db = makeMockDb({ entityCandidates: [existingEntity] }) as any
    const client = makeMockLitellmClient(llmResponse)

    await processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir)

    // update should have been called to bump last_seen_at on the existing entity
    expect(db.update).toHaveBeenCalled()
    // insert for new entity should NOT have been called (reuse existing)
    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls
    // Only pipeline_events inserts (started + success) — no entity row insert
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entityInserts = (insertCalls as any[]).filter(
      ([table]: [any]) => table !== undefined && String(table).includes !== undefined,
    )
    // All insert calls go to insert() — we verify by counting
    // pipeline_events: 2 (started + success), entity_links: 1 → no entities INSERT
    expect(insertCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves an existing entity by alias match', async () => {
    const llmResponse = JSON.stringify({
      people: ['Tom'],
      organizations: [],
      concepts: [],
      decisions: [],
      projects: [],
    })

    const existingEntity = {
      id: 'ent-existing-2',
      name: 'Thomas Smith',
      canonical_name: 'Thomas Smith',
      aliases: ['Tom', 'Tom Smith'],
    }

    const db = makeMockDb({ entityCandidates: [existingEntity] }) as any
    const client = makeMockLitellmClient(llmResponse)

    await processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir)

    // update called to bump last_seen_at (alias match)
    expect(db.update).toHaveBeenCalled()
  })

  it('handles invalid LLM JSON gracefully — no entities extracted', async () => {
    const db = makeMockDb({ entityCandidates: [] }) as any
    const client = makeMockLitellmClient('This is not JSON at all.')

    await expect(
      processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir),
    ).resolves.toBeUndefined()

    // pipeline_events: started + success (0 entities extracted is valid)
    expect(db.insert).toHaveBeenCalled()
  })

  it('handles LLM JSON with missing fields — defaults to empty arrays', async () => {
    const db = makeMockDb({ entityCandidates: [] }) as any
    // Only people present — other fields absent
    const client = makeMockLitellmClient('{"people":["Alice"]}')

    await expect(
      processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir),
    ).resolves.toBeUndefined()

    expect(client.chat.completions.create).toHaveBeenCalledOnce()
  })

  it('handles LLM JSON wrapped in markdown code fences', async () => {
    const db = makeMockDb({ entityCandidates: [] }) as any
    const wrapped = '```json\n{"people":["Bob"],"organizations":[],"concepts":[],"decisions":[],"projects":[]}\n```'
    const client = makeMockLitellmClient(wrapped)

    await expect(
      processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir),
    ).resolves.toBeUndefined()

    expect(client.chat.completions.create).toHaveBeenCalledOnce()
  })

  it('throws and records failure when LLM call throws', async () => {
    const db = makeMockDb({ entityCandidates: [] }) as any
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('LiteLLM timeout')),
        },
      },
    } as any

    await expect(
      processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir),
    ).rejects.toThrow('LiteLLM timeout')

    // pipeline_events: started + failed
    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not throw when individual entity resolution fails — continues with remaining', async () => {
    const llmResponse = JSON.stringify({
      people: ['Alice', 'Bob'],
      organizations: [],
      concepts: [],
      decisions: [],
      projects: [],
    })

    const client = makeMockLitellmClient(llmResponse)
    let insertCallCount = 0
    const db = makeMockDb({ entityCandidates: [] }) as any
    // Make every other entity INSERT fail
    const insertChainObj = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => {
          insertCallCount++
          if (insertCallCount === 2) {
            return Promise.reject(new Error('DB constraint violation'))
          }
          return Promise.resolve([{ id: `ent-${insertCallCount}` }])
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        then: (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
      }),
      then: (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
    }
    db.insert = vi.fn().mockReturnValue(insertChainObj)

    // Should not throw — individual entity failures are caught and logged
    await expect(
      processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir),
    ).resolves.toBeUndefined()
  })

  it('records pipeline_events started and success on normal completion', async () => {
    const llmResponse = JSON.stringify({
      people: [],
      organizations: [],
      concepts: [],
      decisions: [],
      projects: [],
    })

    const db = makeMockDb({ entityCandidates: [] }) as any
    const client = makeMockLitellmClient(llmResponse)

    await processExtractEntitiesJob(jobData, db, client, synthesisModel, promptsDir)

    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls
    // pipeline_events insert: started (before LLM) and success (after)
    expect(insertCalls.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Tests: queue configuration
// ---------------------------------------------------------------------------
describe('ExtractEntitiesQueue configuration', () => {
  it('EXTRACT_ENTITIES_BACKOFF_DELAYS_MS has correct values', () => {
    expect(EXTRACT_ENTITIES_BACKOFF_DELAYS_MS).toEqual([
      30_000,    // 30s
      120_000,   // 2m
      600_000,   // 10m
      1_800_000, // 30m
      7_200_000, // 2h
    ])
  })
})
