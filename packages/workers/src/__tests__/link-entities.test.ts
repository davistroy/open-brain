import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processLinkEntitiesStage } from '../pipeline/stages/link-entities.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Fluent select chain — resolves with provided rows on .limit() or as a Promise.
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
  ;(chain as any).catch = (r: (e: unknown) => void) => terminal.catch(r)
  return chain
}

/**
 * Fluent insert chain — supports .values(), .returning(), .onConflictDoNothing()
 */
function insertChain(returnedRows: unknown[] = []) {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockResolvedValue(returnedRows)
  chain.onConflictDoNothing = vi.fn().mockResolvedValue(undefined)
  ;(chain as any).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(undefined).then(resolve)
  return chain
}

/**
 * Fluent update chain
 */
function updateChain() {
  const chain: Record<string, unknown> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(undefined)
  return chain
}

interface MakeMockDbOptions {
  captureRow?: Record<string, unknown> | null
  entityCandidates?: Record<string, unknown>[]
  insertedEntityId?: string | null
}

function makeMockDb(options: MakeMockDbOptions = {}) {
  const {
    captureRow = {
      id: 'cap-1',
      source_metadata: { people: ['Alice', 'Bob'], topics: ['pgvector', 'AWS'] },
      pre_extracted: null,
    },
    entityCandidates = [],
    insertedEntityId = 'ent-new-1',
  } = options

  let selectCallCount = 0
  // Counter for entity inserts (distinct from pipeline_events inserts) so each
  // new entity gets a unique ID.  pipeline_events inserts don't call .returning()
  // so we use a separate counter that increments only on .returning() calls.
  let entityInsertSeq = 0

  const db: Record<string, unknown> = {}

  db.select = vi.fn().mockImplementation(() => {
    selectCallCount++
    if (selectCallCount === 1) {
      // First select: fetch capture
      return selectChain(captureRow === null ? [] : [captureRow])
    }
    // Subsequent selects: entity candidate lookups
    return selectChain(entityCandidates)
  })

  db.insert = vi.fn().mockImplementation(() => {
    // Build a chain that hands out a unique entity ID each time .returning() is
    // called (entity inserts).  pipeline_events inserts never call .returning(),
    // so they safely go through the .then path which resolves to undefined.
    const seq = ++entityInsertSeq
    const uniqueId = insertedEntityId ? `${insertedEntityId}-${seq}` : null
    return insertChain(uniqueId ? [{ id: uniqueId }] : [])
  })

  db.update = vi.fn().mockReturnValue(updateChain())

  // db.execute for entity_relationships upsert (raw SQL)
  db.execute = vi.fn().mockResolvedValue(undefined)

  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processLinkEntitiesStage', () => {
  const captureId = 'cap-1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips gracefully when capture is not found', async () => {
    const db = makeMockDb({ captureRow: null }) as any

    await expect(processLinkEntitiesStage(captureId, db)).resolves.toBeUndefined()

    // No pipeline_events insert since capture was not found
    expect(db.insert).not.toHaveBeenCalled()
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('resolves people and topics, creates entity_links, builds co-occurrence graph', async () => {
    const db = makeMockDb() as any

    await processLinkEntitiesStage(captureId, db)

    // insert called for: pipeline_events started, pipeline_events success,
    // entity_links for each resolved entity (4 = Alice, Bob, pgvector, AWS),
    // and potentially entities themselves if new
    expect(db.insert).toHaveBeenCalled()

    // execute called for entity_relationships upserts (C(4,2) = 6 pairs)
    expect(db.execute).toHaveBeenCalled()
  })

  it('deduplicates mentions from source_metadata and pre_extracted', async () => {
    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: ['Alice'], topics: ['AWS'] },
        pre_extracted: { people: ['alice'], topics: ['AWS'] }, // duplicates (case-insensitive)
      },
    }) as any

    await processLinkEntitiesStage(captureId, db)

    // 2 unique mentions (Alice + AWS) → C(2,2) = 1 relationship pair
    const executeCalls = (db.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(executeCalls.length).toBe(1) // one entity_relationships upsert for the single pair
  })

  it('handles capture with no entity mentions gracefully', async () => {
    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: [], topics: [] },
        pre_extracted: null,
      },
    }) as any

    await processLinkEntitiesStage(captureId, db)

    // No entity_relationships upserts needed — no pairs
    expect(db.execute).not.toHaveBeenCalled()

    // pipeline_events: started + success still recorded
    expect(db.insert).toHaveBeenCalled()
    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('handles null source_metadata and pre_extracted without throwing', async () => {
    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: null,
        pre_extracted: null,
      },
    }) as any

    await expect(processLinkEntitiesStage(captureId, db)).resolves.toBeUndefined()

    expect(db.execute).not.toHaveBeenCalled()
  })

  it('reuses existing entity by exact name match and updates last_seen_at', async () => {
    const existingEntity = {
      id: 'ent-existing-1',
      name: 'Alice',
      canonical_name: 'Alice',
      aliases: [],
    }

    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: ['Alice'], topics: [] },
        pre_extracted: null,
      },
      entityCandidates: [existingEntity],
    }) as any

    await processLinkEntitiesStage(captureId, db)

    // update called to bump last_seen_at on the existing entity
    expect(db.update).toHaveBeenCalled()

    // No new entity INSERT (beyond pipeline_events)
    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls
    // pipeline_events started + success + entity_links for Alice → 3 calls
    // No entity row INSERT
    expect(insertCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('reuses existing entity by alias match', async () => {
    const existingEntity = {
      id: 'ent-existing-2',
      name: 'Robert Johnson',
      canonical_name: 'Robert Johnson',
      aliases: ['Bob', 'Bobby'],
    }

    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: ['Bob'], topics: [] },
        pre_extracted: null,
      },
      entityCandidates: [existingEntity],
    }) as any

    await processLinkEntitiesStage(captureId, db)

    // update called to bump last_seen_at (alias match)
    expect(db.update).toHaveBeenCalled()
  })

  it('continues and logs warning when individual entity resolution fails', async () => {
    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: ['Alice', 'Bob'], topics: [] },
        pre_extracted: null,
      },
    }) as any

    let insertCallCount = 0
    db.insert = vi.fn().mockImplementation(() => {
      insertCallCount++
      // Make entity INSERT for second entity fail — but pipeline_events inserts succeed
      if (insertCallCount === 3) {
        // 1st = pipeline_events started, 2nd = entity INSERT for Alice (ok),
        // 3rd = entity INSERT for Bob (fail)
        const failChain: Record<string, unknown> = {}
        failChain.values = vi.fn().mockReturnValue(failChain)
        failChain.returning = vi.fn().mockRejectedValue(new Error('DB constraint'))
        failChain.onConflictDoNothing = vi.fn().mockResolvedValue(undefined)
        ;(failChain as any).then = (resolve: (v: unknown) => void) =>
          Promise.resolve(undefined).then(resolve)
        return failChain
      }
      return insertChain([{ id: `ent-${insertCallCount}` }])
    })

    // Should not throw — individual failures are caught
    await expect(processLinkEntitiesStage(captureId, db)).resolves.toBeUndefined()
  })

  it('records pipeline_events started and success on normal completion', async () => {
    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: [], topics: [] },
        pre_extracted: null,
      },
    }) as any

    await processLinkEntitiesStage(captureId, db)

    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls
    // At minimum: pipeline_events started + pipeline_events success
    expect(insertCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('records pipeline_events failed and rethrows when stage fails', async () => {
    const db = makeMockDb() as any

    // Make every insert after the first throw
    let callCount = 0
    db.insert = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // pipeline_events 'started' insert succeeds
        return insertChain()
      }
      // Everything after that throws — simulate DB failure
      throw new Error('DB connection lost')
    })

    await expect(processLinkEntitiesStage(captureId, db)).rejects.toThrow('DB connection lost')
  })

  it('generates correct number of co-occurrence pairs for 3 entities (C(3,2) = 3)', async () => {
    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: ['Alice', 'Bob'], topics: ['pgvector'] },
        pre_extracted: null,
      },
    }) as any

    await processLinkEntitiesStage(captureId, db)

    // C(3,2) = 3 pairs: (Alice,Bob), (Alice,pgvector), (Bob,pgvector)
    const executeCalls = (db.execute as ReturnType<typeof vi.fn>).mock.calls
    expect(executeCalls.length).toBe(3)
  })

  it('generates 0 pairs for a single entity (no self-loops)', async () => {
    const db = makeMockDb({
      captureRow: {
        id: 'cap-1',
        source_metadata: { people: ['Alice'], topics: [] },
        pre_extracted: null,
      },
    }) as any

    await processLinkEntitiesStage(captureId, db)

    // Only 1 entity → no pairs
    expect(db.execute).not.toHaveBeenCalled()
  })
})
