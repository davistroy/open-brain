import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock pg (required by health.ts which registers /health globally)
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
// Mock data
// ---------------------------------------------------------------------------

const sampleRows = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    timestamp: new Date('2026-04-10T12:00:00Z'),
    client_id: 'abc123',
    tool_name: 'search_brain',
    parameters: { query: 'test' },
    result_summary: 'Found 3 results',
    duration_ms: 42,
    metadata: null,
    created_at: new Date('2026-04-10T12:00:00Z'),
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    timestamp: new Date('2026-04-10T11:00:00Z'),
    client_id: 'abc123',
    tool_name: 'brain_stats',
    parameters: {},
    result_summary: '42 captures total',
    duration_ms: 15,
    metadata: null,
    created_at: new Date('2026-04-10T11:00:00Z'),
  },
]

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function makeMockDb(rows: unknown[] = sampleRows, total = 2) {
  // select().from().where().orderBy().limit().offset() → rows
  // select().from().where() → [{ count: total }]
  const orderByMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockReturnValue({
      offset: vi.fn().mockResolvedValue(rows),
    }),
  })
  const whereMockItems = vi.fn().mockReturnValue({
    orderBy: orderByMock,
  })
  const whereMockCount = vi.fn().mockResolvedValue([{ count: String(total) }])

  let selectCallCount = 0
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++
      if (selectCallCount % 2 === 1) {
        // Items query
        return {
          from: vi.fn().mockReturnValue({
            where: whereMockItems,
          }),
        }
      } else {
        // Count query
        return {
          from: vi.fn().mockReturnValue({
            where: whereMockCount,
          }),
        }
      }
    }),
    // Required stubs for other routes that check db existence
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/mcp/activity', () => {
  let mockDb: ReturnType<typeof makeMockDb>

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = makeMockDb()
  })

  it('returns paginated results with default limit and offset', async () => {
    const app = createApp({ db: mockDb as any })
    const res = await app.request('/api/v1/mcp/activity', {
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items[0].tool_name).toBe('search_brain')
    expect(body.items[0].client_id).toBe('abc123')
    expect(body.items[0].duration_ms).toBe(42)
    expect(body.items[1].tool_name).toBe('brain_stats')
    expect(body.total).toBe(2)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
  })

  it('respects limit and offset query params', async () => {
    const app = createApp({ db: mockDb as any })
    const res = await app.request('/api/v1/mcp/activity?limit=10&offset=5', {
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.limit).toBe(10)
    expect(body.offset).toBe(5)
  })

  it('clamps limit to max 200', async () => {
    const app = createApp({ db: mockDb as any })
    const res = await app.request('/api/v1/mcp/activity?limit=999', {
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.limit).toBe(200)
  })

  it('clamps offset to min 0', async () => {
    const app = createApp({ db: mockDb as any })
    const res = await app.request('/api/v1/mcp/activity?offset=-5', {
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.offset).toBe(0)
  })

  it('returns empty result when no rows', async () => {
    const emptyDb = makeMockDb([], 0)
    const app = createApp({ db: emptyDb as any })
    const res = await app.request('/api/v1/mcp/activity', {
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
  })
})
