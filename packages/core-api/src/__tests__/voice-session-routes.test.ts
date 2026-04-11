import { describe, it, expect, vi } from 'vitest'
import { createApp } from '../app.js'
import type { VoiceSessionService } from '../services/voice-session.js'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_SESSION = {
  id: 'vs-uuid-1',
  session_key: 'pipecat-abc123',
  started_at: new Date('2026-04-11T09:00:00Z'),
  ended_at: null,
  duration_seconds: null,
  turn_count: 0,
  transcript: [],
  summary: null,
  captures_created: [],
  metadata: {},
  created_at: new Date('2026-04-11T09:00:00Z'),
}

const COMPLETED_SESSION = {
  ...SAMPLE_SESSION,
  ended_at: new Date('2026-04-11T10:00:00Z'),
  duration_seconds: 3600,
  turn_count: 4,
  transcript: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
  ],
  summary: 'Test conversation summary',
  captures_created: ['cap-1'],
}

// ---------------------------------------------------------------------------
// Mock service factory
// ---------------------------------------------------------------------------

function makeMockService(overrides: Partial<VoiceSessionService> = {}): VoiceSessionService {
  return {
    create: vi.fn().mockResolvedValue(SAMPLE_SESSION),
    update: vi.fn().mockResolvedValue(SAMPLE_SESSION),
    complete: vi.fn().mockResolvedValue(COMPLETED_SESSION),
    list: vi.fn().mockResolvedValue({ items: [SAMPLE_SESSION], total: 1 }),
    get: vi.fn().mockResolvedValue(SAMPLE_SESSION),
    getActive: vi.fn().mockResolvedValue([SAMPLE_SESSION]),
    setActivityFeedService: vi.fn(),
    ...overrides,
  } as unknown as VoiceSessionService
}

// ---------------------------------------------------------------------------
// GET /api/v1/voice/sessions
// ---------------------------------------------------------------------------

describe('GET /api/v1/voice/sessions', () => {
  it('returns paginated session list with defaults', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions')

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe('vs-uuid-1')
    expect(body.total).toBe(1)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
    expect(voiceSessionService.list).toHaveBeenCalledWith(50, 0)
  })

  it('passes limit and offset params', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    await app.request('/api/v1/voice/sessions?limit=10&offset=5')

    expect(voiceSessionService.list).toHaveBeenCalledWith(10, 5)
  })

  it('caps limit at 100', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    await app.request('/api/v1/voice/sessions?limit=500')

    expect(voiceSessionService.list).toHaveBeenCalledWith(100, 0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/voice/sessions/active
// ---------------------------------------------------------------------------

describe('GET /api/v1/voice/sessions/active', () => {
  it('returns active sessions', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/active')

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.items).toHaveLength(1)
    expect(body.items[0].ended_at).toBeNull()
    expect(voiceSessionService.getActive).toHaveBeenCalled()
  })

  it('returns empty array when no active sessions', async () => {
    const voiceSessionService = makeMockService({
      getActive: vi.fn().mockResolvedValue([]),
    })
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/active')

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/voice/sessions/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/voice/sessions/:id', () => {
  it('returns session by id', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1')

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.id).toBe('vs-uuid-1')
    expect(voiceSessionService.get).toHaveBeenCalledWith('vs-uuid-1')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/voice/sessions
// ---------------------------------------------------------------------------

describe('POST /api/v1/voice/sessions', () => {
  it('creates a new session', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_key: 'pipecat-abc123' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.id).toBe('vs-uuid-1')
    expect(body.session_key).toBe('pipecat-abc123')
    expect(voiceSessionService.create).toHaveBeenCalledWith({
      sessionKey: 'pipecat-abc123',
      metadata: undefined,
    })
  })

  it('accepts optional metadata', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    await app.request('/api/v1/voice/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_key: 'pipecat-abc123',
        metadata: { client: 'ios' },
      }),
    })

    expect(voiceSessionService.create).toHaveBeenCalledWith({
      sessionKey: 'pipecat-abc123',
      metadata: { client: 'ios' },
    })
  })

  it('rejects missing session_key', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('rejects invalid JSON body', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/voice/sessions/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/voice/sessions/:id', () => {
  it('updates session with partial data', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turn_count: 3, summary: 'Updated summary' }),
    })

    expect(res.status).toBe(200)
    expect(voiceSessionService.update).toHaveBeenCalledWith('vs-uuid-1', {
      turn_count: 3,
      summary: 'Updated summary',
    })
  })

  it('validates turn_count is integer', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turn_count: 'not-a-number' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('validates transcript is array', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'not-an-array' }),
    })

    expect(res.status).toBe(400)
  })

  it('validates metadata is object', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: 'string-not-object' }),
    })

    expect(res.status).toBe(400)
  })

  it('rejects invalid JSON body', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'broken',
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/voice/sessions/:id/complete
// ---------------------------------------------------------------------------

describe('POST /api/v1/voice/sessions/:id/complete', () => {
  it('completes session with transcript and summary', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
        ],
        summary: 'Test summary',
        capture_ids: ['cap-1'],
      }),
    })

    expect(res.status).toBe(200)
    expect(voiceSessionService.complete).toHaveBeenCalledWith(
      'vs-uuid-1',
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
      'Test summary',
      ['cap-1'],
    )
  })

  it('defaults capture_ids to empty array', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    await app.request('/api/v1/voice/sessions/vs-uuid-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: [],
        summary: 'Empty conversation',
      }),
    })

    expect(voiceSessionService.complete).toHaveBeenCalledWith(
      'vs-uuid-1',
      [],
      'Empty conversation',
      [],
    )
  })

  it('rejects missing transcript', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'No transcript' }),
    })

    expect(res.status).toBe(400)
  })

  it('rejects missing summary', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: [] }),
    })

    expect(res.status).toBe(400)
  })

  it('rejects empty summary', async () => {
    const voiceSessionService = makeMockService()
    const app = createApp({ voiceSessionService })

    const res = await app.request('/api/v1/voice/sessions/vs-uuid-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: [], summary: '  ' }),
    })

    expect(res.status).toBe(400)
  })
})
