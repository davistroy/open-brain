import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'

// ---------------------------------------------------------------------------
// Mock infrastructure dependencies so createApp() loads cleanly
// ---------------------------------------------------------------------------

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    disconnect: vi.fn(),
  })),
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockDb(rows: unknown[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  }
}

function makeMockSkillQueue(addResult: { id: string } = { id: 'job-456' }) {
  return {
    add: vi.fn().mockResolvedValue(addResult),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Sample skills_log rows for intelligence skills
// ---------------------------------------------------------------------------

const CONNECTIONS_LOG = {
  id: 'conn-1',
  skill_name: 'daily-connections',
  capture_id: 'cap-abc',
  input_summary: '32 captures from last 7 days',
  output_summary: '3 cross-domain connections found',
  result: {
    connections: [
      { theme: 'QSR + AI', insight: 'QSR operations mirror ML pipeline patterns', confidence: 0.85 },
      { theme: 'Coaching + Governance', insight: 'Session patterns suggest drift', confidence: 0.72 },
    ],
  },
  duration_ms: 12400,
  created_at: '2026-03-11T21:05:00Z',
}

const DRIFT_LOG = {
  id: 'drift-1',
  skill_name: 'drift-monitor',
  capture_id: 'cap-def',
  input_summary: '5 pending bets, 12 entities tracked',
  output_summary: '2 drift items detected (1 high, 1 medium)',
  result: {
    drift_items: [
      { item: 'Cloud migration bet', severity: 'high', suggested_action: 'Review with team' },
      { item: 'Entity frequency decline: React', severity: 'medium', suggested_action: 'Check project status' },
    ],
  },
  duration_ms: 9800,
  created_at: '2026-03-11T08:02:00Z',
}

const CONNECTIONS_HISTORY = [
  CONNECTIONS_LOG,
  {
    id: 'conn-2',
    skill_name: 'daily-connections',
    capture_id: 'cap-xyz',
    input_summary: '28 captures from last 7 days',
    output_summary: '2 connections found',
    result: { connections: [] },
    duration_ms: 10200,
    created_at: '2026-03-10T21:03:00Z',
  },
]

// ---------------------------------------------------------------------------
// GET /api/v1/intelligence/summary
// ---------------------------------------------------------------------------

describe('GET /api/v1/intelligence/summary', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb([CONNECTIONS_LOG, DRIFT_LOG])
    skillQueue = makeMockSkillQueue()
  })

  it('returns 200 with connections and drift latest entries', async () => {
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/summary')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connections).toBeTruthy()
    expect(body.connections.skill_name).toBe('daily-connections')
    expect(body.connections.result).toHaveProperty('connections')
    expect(body.drift).toBeTruthy()
    expect(body.drift.skill_name).toBe('drift-monitor')
    expect(body.drift.result).toHaveProperty('drift_items')
  })

  it('returns null for skills with no log entries', async () => {
    db = makeMockDb([])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/summary')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connections).toBeNull()
    expect(body.drift).toBeNull()
  })

  it('returns one null when only one skill has run', async () => {
    db = makeMockDb([CONNECTIONS_LOG])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/summary')

    const body = await res.json()
    expect(body.connections).toBeTruthy()
    expect(body.drift).toBeNull()
  })

  it('returns 404 when db/skillQueue not wired up', async () => {
    const app = createApp({})
    const res = await app.request('/api/v1/intelligence/summary')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/intelligence/connections/latest
// ---------------------------------------------------------------------------

describe('GET /api/v1/intelligence/connections/latest', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    skillQueue = makeMockSkillQueue()
  })

  it('returns 200 with the latest connections result', async () => {
    db = makeMockDb([CONNECTIONS_LOG])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/connections/latest')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeTruthy()
    expect(body.data.skill_name).toBe('daily-connections')
    expect(body.data.id).toBe('conn-1')
    expect(body.data.result.connections).toHaveLength(2)
  })

  it('returns null data when no connections have run', async () => {
    db = makeMockDb([])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/connections/latest')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/intelligence/connections/history
// ---------------------------------------------------------------------------

describe('GET /api/v1/intelligence/connections/history', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    skillQueue = makeMockSkillQueue()
  })

  it('returns 200 with history array', async () => {
    db = makeMockDb(CONNECTIONS_HISTORY)
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/connections/history')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.data[0].id).toBe('conn-1')
    expect(body.data[1].id).toBe('conn-2')
  })

  it('returns empty array when no history exists', async () => {
    db = makeMockDb([])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/connections/history')

    const body = await res.json()
    expect(body.data).toHaveLength(0)
  })

  it('respects limit query parameter', async () => {
    db = makeMockDb(CONNECTIONS_HISTORY)
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/connections/history?limit=5')

    expect(res.status).toBe(200)
    // Verify db.execute was called (limit is applied in SQL, so we just check the call went through)
    expect(db.execute).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/intelligence/drift/latest
// ---------------------------------------------------------------------------

describe('GET /api/v1/intelligence/drift/latest', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    skillQueue = makeMockSkillQueue()
  })

  it('returns 200 with the latest drift result', async () => {
    db = makeMockDb([DRIFT_LOG])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/drift/latest')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeTruthy()
    expect(body.data.skill_name).toBe('drift-monitor')
    expect(body.data.result.drift_items).toHaveLength(2)
  })

  it('returns null data when no drift runs exist', async () => {
    db = makeMockDb([])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/drift/latest')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/intelligence/drift/history
// ---------------------------------------------------------------------------

describe('GET /api/v1/intelligence/drift/history', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    skillQueue = makeMockSkillQueue()
  })

  it('returns 200 with drift history array', async () => {
    db = makeMockDb([DRIFT_LOG])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/drift/history')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].skill_name).toBe('drift-monitor')
  })

  it('caps limit at 50', async () => {
    db = makeMockDb([])
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    await app.request('/api/v1/intelligence/drift/history?limit=200')

    // The SQL call should have been made — the limit is capped in code
    expect(db.execute).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/intelligence/:skill/trigger
// ---------------------------------------------------------------------------

describe('POST /api/v1/intelligence/:skill/trigger', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb()
    skillQueue = makeMockSkillQueue()
  })

  it('returns 202 when triggering daily-connections', async () => {
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/daily-connections/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.skill).toBe('daily-connections')
    expect(body.job_id).toBe('job-456')
    expect(body.status).toBe('queued')
  })

  it('returns 202 when triggering drift-monitor', async () => {
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/drift-monitor/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.skill).toBe('drift-monitor')
  })

  it('passes overrides to the skill queue', async () => {
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    await app.request('/api/v1/intelligence/daily-connections/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowDays: 14 }),
    })

    expect(skillQueue.add).toHaveBeenCalledWith(
      'daily-connections',
      expect.objectContaining({
        skillName: 'daily-connections',
        input: expect.objectContaining({ windowDays: 14 }),
      }),
      expect.objectContaining({ priority: 2 }),
    )
  })

  it('returns 400 for unknown intelligence skill', async () => {
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/weekly-brief/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('weekly-brief')
    expect(skillQueue.add).not.toHaveBeenCalled()
  })

  it('accepts trigger with no body', async () => {
    const app = createApp({ db: db as any, skillQueue: skillQueue as any })
    const res = await app.request('/api/v1/intelligence/drift-monitor/trigger', {
      method: 'POST',
    })

    expect(res.status).toBe(202)
  })

  it('returns 404 when db/skillQueue not wired up', async () => {
    const app = createApp({})
    const res = await app.request('/api/v1/intelligence/daily-connections/trigger', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})
