import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import type { BetService } from '../services/bet.js'

// ---------------------------------------------------------------------------
// Mock BetService
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

const RESOLVED_BET = {
  ...SAMPLE_BET,
  resolution: 'correct',
  resolution_notes: 'Confirmed by pricing data',
  updated_at: new Date('2026-12-31T00:00:00Z'),
}

function makeMockBetService(overrides: Partial<BetService> = {}): BetService {
  return {
    create: vi.fn().mockResolvedValue(SAMPLE_BET),
    list: vi.fn().mockResolvedValue({ items: [SAMPLE_BET], total: 1 }),
    getById: vi.fn().mockResolvedValue(SAMPLE_BET),
    resolve: vi.fn().mockResolvedValue(RESOLVED_BET),
    getExpiring: vi.fn().mockResolvedValue([SAMPLE_BET]),
    ...overrides,
  } as unknown as BetService
}

// ---------------------------------------------------------------------------
// GET /api/v1/bets
// ---------------------------------------------------------------------------

describe('GET /api/v1/bets', () => {
  it('returns paginated bet list with defaults', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe('bet-uuid-1')
    expect(body.total).toBe(1)
    expect(body.limit).toBe(20)
    expect(body.offset).toBe(0)
    expect(betService.list).toHaveBeenCalledWith(undefined, 20, 0)
  })

  it('passes status filter to BetService.list', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets?status=pending&limit=10&offset=5')

    expect(res.status).toBe(200)
    expect(betService.list).toHaveBeenCalledWith('pending', 10, 5)
  })

  it('returns 400 for invalid status filter', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets?status=invalid')

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('Invalid status filter')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/bets
// ---------------------------------------------------------------------------

describe('POST /api/v1/bets', () => {
  it('creates a bet and returns 201', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statement: 'LLM costs drop 80% by end of 2026',
        confidence: 0.75,
        domain: 'technical',
        due_date: '2026-12-31T00:00:00Z',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.id).toBe('bet-uuid-1')
    expect(betService.create).toHaveBeenCalledWith({
      statement: 'LLM costs drop 80% by end of 2026',
      confidence: 0.75,
      domain: 'technical',
      due_date: expect.any(Date),
      session_id: undefined,
    })
  })

  it('returns 400 when statement is missing', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confidence: 0.5 }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('statement is required')
  })

  it('returns 400 when confidence is missing', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'Some prediction' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('confidence is required')
  })

  it('returns 400 when confidence is out of range', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'Some prediction', confidence: 1.5 }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('between 0.0 and 1.0')
  })

  it('returns 400 when due_date is invalid', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'Some prediction', confidence: 0.5, due_date: 'not-a-date' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('ISO 8601')
  })

  it('returns 400 on invalid JSON body', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('Invalid JSON')
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/bets/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/bets/:id', () => {
  it('returns the bet when found', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/bet-uuid-1')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe('bet-uuid-1')
    expect(betService.getById).toHaveBeenCalledWith('bet-uuid-1')
  })

  it('returns 404 when bet not found (NotFoundError propagated)', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const betService = makeMockBetService({
      getById: vi.fn().mockRejectedValue(new NotFoundError('Bet not found: missing-id')),
    })
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/missing-id')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/bets/expiring
// ---------------------------------------------------------------------------

describe('GET /api/v1/bets/expiring', () => {
  it('returns expiring bets with default 7 days', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/expiring')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.items).toHaveLength(1)
    expect(body.days_ahead).toBe(7)
    expect(betService.getExpiring).toHaveBeenCalledWith(7)
  })

  it('respects custom ?days= parameter', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/expiring?days=14')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.days_ahead).toBe(14)
    expect(betService.getExpiring).toHaveBeenCalledWith(14)
  })

  it('falls back to 7 days for invalid ?days= value', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/expiring?days=abc')

    expect(res.status).toBe(200)
    expect(betService.getExpiring).toHaveBeenCalledWith(7)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/bets/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/bets/:id', () => {
  it('resolves a bet and returns the updated record', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/bet-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'correct', evidence: 'Confirmed by pricing data' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.resolution).toBe('correct')
    expect(betService.resolve).toHaveBeenCalledWith('bet-uuid-1', {
      resolution: 'correct',
      evidence: 'Confirmed by pricing data',
    })
  })

  it('accepts incorrect resolution', async () => {
    const betService = makeMockBetService({
      resolve: vi.fn().mockResolvedValue({ ...SAMPLE_BET, resolution: 'incorrect' }),
    })
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/bet-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'incorrect' }),
    })

    expect(res.status).toBe(200)
    expect(betService.resolve).toHaveBeenCalledWith('bet-uuid-1', {
      resolution: 'incorrect',
      evidence: undefined,
    })
  })

  it('accepts ambiguous resolution without evidence', async () => {
    const betService = makeMockBetService({
      resolve: vi.fn().mockResolvedValue({ ...SAMPLE_BET, resolution: 'ambiguous' }),
    })
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/bet-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'ambiguous' }),
    })

    expect(res.status).toBe(200)
  })

  it('returns 400 when resolution is missing', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/bet-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidence: 'Some note' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('resolution is required')
  })

  it('returns 400 for invalid resolution value', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/bet-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'won' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 on invalid JSON body', async () => {
    const betService = makeMockBetService()
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/bet-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('Invalid JSON')
  })

  it('returns 404 when bet not found', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const betService = makeMockBetService({
      resolve: vi.fn().mockRejectedValue(new NotFoundError('Bet not found: missing')),
    })
    const app = createApp({ betService })

    const res = await app.request('/api/v1/bets/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'correct' }),
    })

    expect(res.status).toBe(404)
  })
})
