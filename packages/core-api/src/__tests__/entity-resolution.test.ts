import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EntityResolutionService } from '../services/entity-resolution.js'
import { NotFoundError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock LLMGatewayService
// ---------------------------------------------------------------------------

function makeMockLLM(response: string) {
  return {
    complete: vi.fn().mockResolvedValue(response),
  }
}

// ---------------------------------------------------------------------------
// Mock Database helpers
// ---------------------------------------------------------------------------

function executeChain(rows: unknown[]) {
  return Promise.resolve({ rows })
}

function makeMockDb(overrides: {
  exactRows?: unknown[]
  aliasRows?: unknown[]
  candidateRows?: unknown[]
  insertRow?: unknown
  updateResult?: unknown
  deleteResult?: unknown
} = {}) {
  const {
    exactRows = [],
    aliasRows = [],
    candidateRows = [],
    insertRow = null,
    updateResult = [],
    deleteResult = [],
  } = overrides

  let executeCallCount = 0

  return {
    execute: vi.fn().mockImplementation(() => {
      executeCallCount++
      // Calls in resolve(): 1=exact, 2=alias, 3=candidates
      if (executeCallCount === 1) return executeChain(exactRows)
      if (executeCallCount === 2) return executeChain(aliasRows)
      if (executeCallCount === 3) return executeChain(candidateRows)
      // Subsequent calls: merge/split operations
      return executeChain(updateResult as unknown[])
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertRow ? [insertRow] : []),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(updateResult),
      }),
    }),
  }
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_ENTITY = {
  id: 'entity-uuid-1',
  name: 'Tom Smith',
  entity_type: 'person',
  canonical_name: 'tom smith',
  aliases: ['Tom', 'Tommy'],
}

// ---------------------------------------------------------------------------
// Tier 1: Exact match
// ---------------------------------------------------------------------------

describe('EntityResolutionService.resolve — exact match', () => {
  it('returns exact_match when name matches case-insensitively', async () => {
    const db = {
      execute: vi.fn().mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),
      insert: vi.fn(),
    }

    const service = new EntityResolutionService(db as any)
    const result = await service.resolve('Tom Smith')

    expect(result.outcome).toBe('exact_match')
    expect(result.entity_id).toBe('entity-uuid-1')
    expect(result.confidence).toBe(1.0)
    // Should only call execute once (exact match found)
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('returns exact_match for case-insensitive comparison', async () => {
    const db = {
      execute: vi.fn().mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),
      insert: vi.fn(),
    }

    const service = new EntityResolutionService(db as any)
    const result = await service.resolve('TOM SMITH')

    expect(result.outcome).toBe('exact_match')
  })
})

// ---------------------------------------------------------------------------
// Tier 2: Alias match
// ---------------------------------------------------------------------------

describe('EntityResolutionService.resolve — alias match', () => {
  it('returns alias_match when mention is in aliases array', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })  // exact: no match
        .mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),  // alias: match
      insert: vi.fn(),
    }

    const service = new EntityResolutionService(db as any)
    const result = await service.resolve('Tom')

    expect(result.outcome).toBe('alias_match')
    expect(result.entity_id).toBe('entity-uuid-1')
    expect(result.confidence).toBe(0.95)
    expect(db.execute).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Tier 3: LLM disambiguation — match (confidence >= 0.8)
// ---------------------------------------------------------------------------

describe('EntityResolutionService.resolve — LLM match', () => {
  it('returns llm_match when LLM confidence >= 0.8', async () => {
    const llmResponse = JSON.stringify({
      match_index: 1,
      confidence: 0.9,
      reasoning: 'Same person based on context',
    })

    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })  // exact: no match
        .mockResolvedValueOnce({ rows: [] })  // alias: no match
        .mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),  // candidates
      insert: vi.fn(),
    }

    const llm = makeMockLLM(llmResponse)
    const service = new EntityResolutionService(db as any, llm as any)

    const result = await service.resolve('Tom at QSR', 'person', 'QSR project context')

    expect(result.outcome).toBe('llm_match')
    expect(result.entity_id).toBe('entity-uuid-1')
    expect(result.confidence).toBe(0.9)
    expect(llm.complete).toHaveBeenCalledOnce()
  })

  it('creates new entity when LLM confidence < 0.8', async () => {
    const llmResponse = JSON.stringify({
      match_index: 1,
      confidence: 0.6,
      reasoning: 'Likely different person',
    })

    const insertedEntity = { id: 'new-entity-uuid' }
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })  // exact
        .mockResolvedValueOnce({ rows: [] })  // alias
        .mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),  // candidates
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([insertedEntity]),
        }),
      }),
    }

    const llm = makeMockLLM(llmResponse)
    const service = new EntityResolutionService(db as any, llm as any)

    const result = await service.resolve('Different Tom')

    expect(result.outcome).toBe('created')
    expect(result.entity_id).toBe('new-entity-uuid')
    expect(db.insert).toHaveBeenCalledOnce()
  })

  it('creates new entity when LLM match_index is null', async () => {
    const llmResponse = JSON.stringify({
      match_index: null,
      confidence: 0.4,
      reasoning: 'No match found',
    })

    const insertedEntity = { id: 'new-entity-uuid-2' }
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([insertedEntity]),
        }),
      }),
    }

    const llm = makeMockLLM(llmResponse)
    const service = new EntityResolutionService(db as any, llm as any)

    const result = await service.resolve('Unknown Person')

    expect(result.outcome).toBe('created')
    expect(db.insert).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// New entity creation — no candidates
// ---------------------------------------------------------------------------

describe('EntityResolutionService.resolve — new entity creation', () => {
  it('creates new entity when no candidates exist', async () => {
    const insertedEntity = { id: 'brand-new-entity' }
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })  // exact
        .mockResolvedValueOnce({ rows: [] })  // alias
        .mockResolvedValueOnce({ rows: [] }),  // candidates: empty
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([insertedEntity]),
        }),
      }),
    }

    const service = new EntityResolutionService(db as any)
    const result = await service.resolve('Brand New Person', 'person')

    expect(result.outcome).toBe('created')
    expect(result.entity_id).toBe('brand-new-entity')
    expect(db.insert).toHaveBeenCalledOnce()
  })

  it('falls back to creating entity when LLM fails', async () => {
    const insertedEntity = { id: 'fallback-entity' }
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([insertedEntity]),
        }),
      }),
    }

    const llm = {
      complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    }

    const service = new EntityResolutionService(db as any, llm as any)
    const result = await service.resolve('Someone', 'person')

    expect(result.outcome).toBe('created')
    expect(result.entity_id).toBe('fallback-entity')
  })
})

// ---------------------------------------------------------------------------
// merge()
// ---------------------------------------------------------------------------

describe('EntityResolutionService.merge', () => {
  it('moves entity_links, merges aliases, deletes source', async () => {
    const sourceEntity = { id: 'source-id', name: 'Tom', aliases: ['Tommy'], entity_type: 'person' }
    const targetEntity = { id: 'target-id', name: 'Tom Smith', aliases: ['Thomas'], entity_type: 'person' }

    let executeCallCount = 0
    const db = {
      execute: vi.fn().mockImplementation(() => {
        executeCallCount++
        if (executeCallCount === 1) return Promise.resolve({ rows: [sourceEntity] })  // source lookup
        if (executeCallCount === 2) return Promise.resolve({ rows: [targetEntity] })  // target lookup
        return Promise.resolve({ rows: [] })  // INSERT links, DELETE
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }

    const service = new EntityResolutionService(db as any)
    await service.merge('source-id', 'target-id')

    // execute: 2 lookups + INSERT links + DELETE source = 4 calls
    // update: aliases update via Drizzle chain = 1 call
    expect(db.execute).toHaveBeenCalledTimes(4)
    expect(db.update).toHaveBeenCalledOnce()
  })

  it('throws NotFoundError when source entity does not exist', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })  // source: not found
        .mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] }),  // target: found
    }

    const service = new EntityResolutionService(db as any)
    await expect(service.merge('nonexistent', 'target-id')).rejects.toThrow(NotFoundError)
  })

  it('throws NotFoundError when target entity does not exist', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [SAMPLE_ENTITY] })  // source: found
        .mockResolvedValueOnce({ rows: [] }),  // target: not found
    }

    const service = new EntityResolutionService(db as any)
    await expect(service.merge('source-id', 'nonexistent')).rejects.toThrow(NotFoundError)
  })
})

// ---------------------------------------------------------------------------
// split()
// ---------------------------------------------------------------------------

describe('EntityResolutionService.split', () => {
  it('removes alias from source and creates new entity', async () => {
    const entityWithAlias = { ...SAMPLE_ENTITY, aliases: ['Tom', 'Tommy'] }
    const newEntity = { id: 'split-entity-uuid' }

    const db = {
      execute: vi.fn().mockResolvedValueOnce({ rows: [entityWithAlias] }),  // entity lookup
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newEntity]),
        }),
      }),
    }

    const service = new EntityResolutionService(db as any)
    const result = await service.split('entity-uuid-1', 'Tommy')

    expect(result.new_entity_id).toBe('split-entity-uuid')
    expect(db.insert).toHaveBeenCalledOnce()
    expect(db.execute).toHaveBeenCalledOnce()  // entity lookup
    expect(db.update).toHaveBeenCalledOnce()   // aliases update via Drizzle chain
  })

  it('throws NotFoundError when entity does not exist', async () => {
    const db = {
      execute: vi.fn().mockResolvedValueOnce({ rows: [] }),
      insert: vi.fn(),
    }

    const service = new EntityResolutionService(db as any)
    await expect(service.split('nonexistent', 'Tommy')).rejects.toThrow(NotFoundError)
  })
})
