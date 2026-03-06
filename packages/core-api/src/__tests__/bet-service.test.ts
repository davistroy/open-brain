import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BetService } from '../services/bet.js'
import type { Database } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(overrides: Partial<ReturnType<typeof makeSelectChain>> = {}): Database {
  return {
    select: vi.fn().mockReturnValue(makeSelectChain(overrides)),
    insert: vi.fn().mockReturnValue(makeInsertChain()),
    update: vi.fn().mockReturnValue(makeUpdateChain()),
  } as unknown as Database
}

function makeSelectChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnValue(Promise.resolve([])),
    ...overrides,
  }
  // Make each method return `chain` by default unless overridden
  for (const key of Object.keys(chain)) {
    if (typeof chain[key] === 'function' && !(chain[key] as any).mock?.results) {
      // already overridden
    }
  }
  return chain
}

function makeInsertChain(returning: unknown[] = []) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returning),
    }),
  }
}

function makeUpdateChain(returning: unknown[] = []) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  }
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_BET = {
  id: 'bet-uuid-1',
  statement: 'LLM inference costs will drop 80% by end of 2026',
  confidence: 0.75,
  domain: 'technical',
  resolution_date: new Date('2026-12-31T00:00:00Z'),
  resolution: 'pending',
  resolution_notes: null,
  session_id: null,
  created_at: new Date('2026-03-05T00:00:00Z'),
  updated_at: new Date('2026-03-05T00:00:00Z'),
}

// ---------------------------------------------------------------------------
// BetService.create
// ---------------------------------------------------------------------------

describe('BetService.create', () => {
  it('inserts a bet with default pending resolution and returns it', async () => {
    const db = {
      insert: vi.fn().mockReturnValue(makeInsertChain([SAMPLE_BET])),
      select: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)

    const result = await service.create({
      statement: SAMPLE_BET.statement,
      confidence: 0.75,
      domain: 'technical',
      due_date: new Date('2026-12-31'),
    })

    expect(db.insert).toHaveBeenCalledOnce()
    expect(result.id).toBe('bet-uuid-1')
    expect(result.resolution).toBe('pending')
    expect(result.confidence).toBe(0.75)
  })

  it('creates a bet without optional fields', async () => {
    const minimalBet = { ...SAMPLE_BET, domain: null, resolution_date: null, session_id: null }
    const db = {
      insert: vi.fn().mockReturnValue(makeInsertChain([minimalBet])),
      select: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    const result = await service.create({
      statement: 'Some minimal prediction',
      confidence: 0.5,
    })

    expect(result.domain).toBeNull()
    expect(result.resolution_date).toBeNull()
  })

  it('links bet to session when session_id provided', async () => {
    let capturedValues: Record<string, unknown> | null = null
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals) => {
          capturedValues = vals
          return { returning: vi.fn().mockResolvedValue([{ ...SAMPLE_BET, session_id: 'session-uuid-1' }]) }
        }),
      }),
      select: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    await service.create({
      statement: 'Prediction from governance session',
      confidence: 0.8,
      session_id: 'session-uuid-1',
    })

    expect(capturedValues).not.toBeNull()
    expect((capturedValues as any).session_id).toBe('session-uuid-1')
  })
})

// ---------------------------------------------------------------------------
// BetService.list
// ---------------------------------------------------------------------------

describe('BetService.list', () => {
  it('returns paginated bets with total count', async () => {
    const countResult = [{ count: 3 }]
    const items = [SAMPLE_BET]

    // db.select() is called twice (count + items). Use a counter to return
    // different values per call.
    let callCount = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // count query
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(countResult),
            }),
          }
        }
        // items query
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue(items),
                }),
              }),
            }),
          }),
        }
      }),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    const result = await service.list(undefined, 20, 0)

    expect(result.total).toBe(3)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('bet-uuid-1')
  })

  it('applies status filter when provided', async () => {
    let callCount = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) }) }
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue([SAMPLE_BET]) }),
              }),
            }),
          }),
        }
      }),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    const result = await service.list('pending')
    expect(result.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// BetService.getById
// ---------------------------------------------------------------------------

describe('BetService.getById', () => {
  it('returns the bet when found', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([SAMPLE_BET]),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    const result = await service.getById('bet-uuid-1')
    expect(result.id).toBe('bet-uuid-1')
    expect(result.statement).toBe(SAMPLE_BET.statement)
  })

  it('throws NotFoundError when bet does not exist', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    await expect(service.getById('nonexistent')).rejects.toThrow('Bet not found: nonexistent')
  })
})

// ---------------------------------------------------------------------------
// BetService.resolve
// ---------------------------------------------------------------------------

describe('BetService.resolve', () => {
  function makeResolvableDb(bet = SAMPLE_BET) {
    let selectCallCount = 0
    return {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) {
          // getById call
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([bet]) }),
            }),
          }
        }
        // _captureResolution dedup check (captures table)
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        }
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...bet, resolution: 'correct', resolution_notes: 'On target' }]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Database
  }

  it('resolves a pending bet and returns updated record', async () => {
    const db = makeResolvableDb()
    const service = new BetService(db)

    const result = await service.resolve('bet-uuid-1', {
      resolution: 'correct',
      evidence: 'On target',
    })

    expect(db.update).toHaveBeenCalledOnce()
    expect(result.resolution).toBe('correct')
    expect(result.resolution_notes).toBe('On target')
  })

  it('auto-captures the resolution as a brain entry', async () => {
    const db = makeResolvableDb()
    const service = new BetService(db)

    await service.resolve('bet-uuid-1', { resolution: 'incorrect' })

    // insert should be called once for the auto-capture
    expect(db.insert).toHaveBeenCalledOnce()
    const insertValueCall = (db.insert as any).mock.results[0].value.values.mock.calls[0][0]
    expect(insertValueCall.capture_type).toBe('reflection')
    expect(insertValueCall.source).toBe('system')
    expect(insertValueCall.content).toContain('[LOST]')
    expect(insertValueCall.tags).toContain('incorrect')
  })

  it('auto-capture content includes [WON] for correct resolution', async () => {
    const db = makeResolvableDb()
    const service = new BetService(db)

    await service.resolve('bet-uuid-1', { resolution: 'correct', evidence: 'Prices dropped 85%' })

    const insertValueCall = (db.insert as any).mock.results[0].value.values.mock.calls[0][0]
    expect(insertValueCall.content).toContain('[WON]')
    expect(insertValueCall.content).toContain('Prices dropped 85%')
  })

  it('auto-capture content includes [AMBIGUOUS] for ambiguous resolution', async () => {
    const db = makeResolvableDb()
    const service = new BetService(db)

    await service.resolve('bet-uuid-1', { resolution: 'ambiguous' })

    const insertValueCall = (db.insert as any).mock.results[0].value.values.mock.calls[0][0]
    expect(insertValueCall.content).toContain('[AMBIGUOUS]')
  })

  it('skips auto-capture if duplicate hash already exists', async () => {
    let selectCallCount = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) {
          // getById call — return the bet
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([SAMPLE_BET]) }),
            }),
          }
        }
        // _captureResolution dedup — found a duplicate
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'existing-capture' }]) }),
          }),
        }
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...SAMPLE_BET, resolution: 'correct' }]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Database

    const service = new BetService(db)
    await service.resolve('bet-uuid-1', { resolution: 'correct' })

    // insert should NOT be called because duplicate was found
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('throws when trying to resolve an already-resolved bet', async () => {
    const resolvedBet = { ...SAMPLE_BET, resolution: 'correct' }
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([resolvedBet]) }),
        }),
      }),
      update: vi.fn(),
      insert: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    await expect(service.resolve('bet-uuid-1', { resolution: 'incorrect' })).rejects.toThrow(
      'already resolved',
    )
  })
})

// ---------------------------------------------------------------------------
// BetService.getExpiring
// ---------------------------------------------------------------------------

describe('BetService.getExpiring', () => {
  it('returns bets due within the specified window', async () => {
    const expiringBet = { ...SAMPLE_BET, resolution_date: new Date(Date.now() + 3 * 86_400_000) }
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([expiringBet]),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    const result = await service.getExpiring(7)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('bet-uuid-1')
  })

  it('defaults to 7 days lookahead', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Database

    const service = new BetService(db)
    const result = await service.getExpiring()
    expect(result).toHaveLength(0)
  })
})
