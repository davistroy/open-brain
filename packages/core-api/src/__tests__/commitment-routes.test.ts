import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Infrastructure mocks (required by health.ts and other always-loaded routes)
// ---------------------------------------------------------------------------
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

import { createApp } from '../app.js'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_COMMITMENT = {
  id: 'comm-uuid-1',
  capture_id: 'cap-uuid-1',
  entity_id: 'entity-uuid-1',
  text: 'Send the report to Sarah by Friday',
  due_date: '2026-04-25',
  status: 'owed_by_user',
  resolved_at: null,
  created_at: new Date('2026-04-21T10:00:00Z'),
}

const RESOLVED_COMMITMENT = {
  ...SAMPLE_COMMITMENT,
  id: 'comm-uuid-2',
  status: 'resolved',
  resolved_at: new Date('2026-04-22T09:00:00Z'),
}

// ---------------------------------------------------------------------------
// DB mock factory
//
// The commitments routes use:
//   1. db.select().from().where?().orderBy().limit().offset() → rows  (items)
//   2. db.select().from().where?()                             → rows  (count)
//   3. db.select().from().where().limit()                      → rows  (existence check in PATCH)
//   4. db.update().set().where().returning()                   → [row]  (PATCH)
//   5. db.insert().values().returning()                        → [row]  (POST)
//
// We use a call-index approach: select() alternates items then count per test.
// ---------------------------------------------------------------------------

function makeMockDb({
  selectRows = [SAMPLE_COMMITMENT],
  countRows = [SAMPLE_COMMITMENT],
  existsRows = [SAMPLE_COMMITMENT],
  updateResult = [{ ...SAMPLE_COMMITMENT, status: 'resolved', resolved_at: new Date() }],
  insertResult = [SAMPLE_COMMITMENT],
}: {
  selectRows?: unknown[]
  countRows?: unknown[]
  existsRows?: unknown[]
  updateResult?: unknown[]
  insertResult?: unknown[]
} = {}) {
  let selectCallIndex = 0

  const db = {
    select: vi.fn().mockImplementation(() => {
      const callIndex = selectCallIndex++

      // Build a chainable object. We need to handle two patterns:
      //  - .from().where().orderBy().limit().offset() — paginated list
      //  - .from().where().limit()                   — existence check (returns existsRows)
      //  - .from().where()                           — count query (returns countRows)
      //  - .from().orderBy().limit().offset()         — list without where

      const returnRows = callIndex % 2 === 0 ? selectRows : countRows

      // Innermost chain: resolves with appropriate rows
      const offsetMock = vi.fn().mockResolvedValue(returnRows)
      const limitAfterOrderBy = vi.fn().mockReturnValue({ offset: offsetMock })
      const orderByMock = vi.fn().mockReturnValue({ limit: limitAfterOrderBy, offset: offsetMock })
      // limit without orderBy (existence check path)
      const limitDirectMock = vi.fn().mockResolvedValue(existsRows)

      const whereMock = vi.fn().mockReturnValue({
        orderBy: orderByMock,
        limit: limitDirectMock,
        // resolve directly (count path)
        then: (onfulfilled: (v: unknown) => unknown) => Promise.resolve(countRows).then(onfulfilled),
      })

      const fromMock = vi.fn().mockReturnValue({
        where: whereMock,
        orderBy: orderByMock,
      })

      return { from: fromMock }
    }),

    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(updateResult),
        }),
      }),
    }),

    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertResult),
      }),
    }),
  }

  return db
}

// ---------------------------------------------------------------------------
// GET /api/v1/commitments
// ---------------------------------------------------------------------------

describe('GET /api/v1/commitments', () => {
  it('returns commitment list with defaults', async () => {
    const db = makeMockDb({ selectRows: [SAMPLE_COMMITMENT], countRows: [SAMPLE_COMMITMENT] })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.commitments).toBeDefined()
    expect(Array.isArray(body.commitments)).toBe(true)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
  })

  it('respects limit and offset params', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments?limit=10&offset=5')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.limit).toBe(10)
    expect(body.offset).toBe(5)
  })

  it('caps limit at 200', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments?limit=9999')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.limit).toBe(200)
  })

  it('returns 400 for invalid status filter', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments?status=invalid_status')

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('accepts valid status filter values', async () => {
    for (const status of ['pending', 'owed_by_user', 'waiting_on', 'resolved']) {
      const db = makeMockDb()
      const app = createApp({ db: db as any })

      const res = await app.request(`/api/v1/commitments?status=${status}`)

      expect(res.status).toBe(200)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/entities/:id/commitments
// ---------------------------------------------------------------------------

describe('GET /api/v1/entities/:id/commitments', () => {
  it('returns open commitments for an entity by default', async () => {
    const db = makeMockDb({ selectRows: [SAMPLE_COMMITMENT], countRows: [SAMPLE_COMMITMENT] })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/entities/entity-uuid-1/commitments')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.commitments).toBeDefined()
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
  })

  it('returns all commitments when include_resolved=true', async () => {
    const db = makeMockDb({
      selectRows: [SAMPLE_COMMITMENT, RESOLVED_COMMITMENT],
      countRows: [SAMPLE_COMMITMENT, RESOLVED_COMMITMENT],
    })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/entities/entity-uuid-1/commitments?include_resolved=true')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.commitments).toBeDefined()
  })

  it('respects limit and offset params', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/entities/entity-uuid-1/commitments?limit=5&offset=10')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.limit).toBe(5)
    expect(body.offset).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/commitments/:id — toggle resolved
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/commitments/:id', () => {
  it('marks a commitment as resolved (resolved: true)', async () => {
    const resolvedRow = { ...SAMPLE_COMMITMENT, status: 'resolved', resolved_at: new Date() }
    const db = makeMockDb({
      existsRows: [SAMPLE_COMMITMENT],
      updateResult: [resolvedRow],
    })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments/comm-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.commitment).toBeDefined()
    expect(body.commitment.status).toBe('resolved')
  })

  it('clears resolved state (resolved: false)', async () => {
    const reopenedRow = { ...RESOLVED_COMMITMENT, status: 'pending', resolved_at: null }
    const db = makeMockDb({
      existsRows: [RESOLVED_COMMITMENT],
      updateResult: [reopenedRow],
    })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments/comm-uuid-2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: false }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.commitment).toBeDefined()
    expect(body.commitment.status).toBe('pending')
  })

  it('returns 404 when commitment does not exist', async () => {
    const db = makeMockDb({ existsRows: [] })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments/nonexistent-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    })

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('NOT_FOUND')
  })

  it('returns 400 when `resolved` is missing', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments/comm-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ other_field: 'value' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when `resolved` is not a boolean', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments/comm-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: 'yes' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for invalid JSON body', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments/comm-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/commitments — manual creation
// ---------------------------------------------------------------------------

describe('POST /api/v1/commitments', () => {
  it('creates a commitment with minimal required fields', async () => {
    const db = makeMockDb({ insertResult: [SAMPLE_COMMITMENT] })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Send the report to Sarah by Friday',
        capture_id: 'cap-uuid-1',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.commitment).toBeDefined()
    expect(body.commitment.id).toBe('comm-uuid-1')
  })

  it('creates a commitment with all optional fields', async () => {
    const fullRow = { ...SAMPLE_COMMITMENT, entity_id: 'entity-uuid-1', due_date: '2026-04-30', status: 'waiting_on' }
    const db = makeMockDb({ insertResult: [fullRow] })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ravi owes us the pricing memo',
        capture_id: 'cap-uuid-1',
        entity_id: 'entity-uuid-1',
        due_date: '2026-04-30',
        status: 'waiting_on',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.commitment).toBeDefined()
  })

  it('returns 400 when text is missing', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capture_id: 'cap-uuid-1' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('text')
  })

  it('returns 400 when capture_id is missing', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Some commitment' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('capture_id')
  })

  it('returns 400 for invalid status value', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Some commitment',
        capture_id: 'cap-uuid-1',
        status: 'invalid_status',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for invalid JSON body', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('defaults status to pending when not provided', async () => {
    const pendingRow = { ...SAMPLE_COMMITMENT, status: 'pending' }
    const db = makeMockDb({ insertResult: [pendingRow] })
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/commitments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Review the contract',
        capture_id: 'cap-uuid-1',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.commitment.status).toBe('pending')
  })
})
