import { describe, it, expect, vi } from 'vitest'
import { createApp } from '../app.js'
import type { SessionService } from '../services/session.js'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_SESSION = {
  id: 'session-uuid-1',
  session_type: 'governance',
  status: 'active',
  config: { max_turns: 20, turn_count: 0 },
  context_capture_ids: [],
  summary: null,
  created_at: new Date('2026-03-05T10:00:00Z'),
  updated_at: new Date('2026-03-05T10:00:00Z'),
  completed_at: null,
}

const SAMPLE_TRANSCRIPT = [
  {
    id: 'msg-uuid-1',
    session_id: 'session-uuid-1',
    role: 'assistant',
    content: "Let's begin the quick board check.",
    metadata: { turn_index: 0 },
    created_at: new Date('2026-03-05T10:00:00Z'),
  },
]

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockSessionService(overrides: Partial<SessionService> = {}): SessionService {
  return {
    create: vi.fn().mockResolvedValue({
      session: SAMPLE_SESSION,
      first_message: "Let's begin the quick board check.",
    }),
    list: vi.fn().mockResolvedValue({ items: [SAMPLE_SESSION], total: 1 }),
    getById: vi.fn().mockResolvedValue(SAMPLE_SESSION),
    getWithTranscript: vi.fn().mockResolvedValue({
      ...SAMPLE_SESSION,
      transcript: SAMPLE_TRANSCRIPT,
    }),
    respond: vi.fn().mockResolvedValue({
      session: SAMPLE_SESSION,
      bot_message: 'Board response: what concrete evidence do you have?',
    }),
    pause: vi.fn().mockResolvedValue({ ...SAMPLE_SESSION, status: 'paused' }),
    resume: vi.fn().mockResolvedValue({
      session: { ...SAMPLE_SESSION, status: 'active' },
      context_message: 'Welcome back. This session was paused 2 hours ago.',
    }),
    complete: vi.fn().mockResolvedValue({
      session: { ...SAMPLE_SESSION, status: 'complete', summary: 'Session completed.' },
      summary: 'Session completed.',
    }),
    abandon: vi.fn().mockResolvedValue({ ...SAMPLE_SESSION, status: 'abandoned' }),
    getTranscript: vi.fn().mockResolvedValue(SAMPLE_TRANSCRIPT),
    ...overrides,
  } as unknown as SessionService
}

// ---------------------------------------------------------------------------
// POST /api/v1/sessions — create
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions', () => {
  it('creates a governance session and returns 201 with session + first_message', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'governance' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.session.id).toBe('session-uuid-1')
    expect(body.first_message).toContain("board check")
    expect(sessionService.create).toHaveBeenCalledWith({ type: 'governance', config: undefined })
  })

  it('creates a review session', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'review' }),
    })

    expect(res.status).toBe(201)
    expect(sessionService.create).toHaveBeenCalledWith({ type: 'review', config: undefined })
  })

  it('passes config to SessionService when provided', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'governance',
        config: { max_turns: 10, focus_brain_views: ['technical'] },
      }),
    })

    expect(sessionService.create).toHaveBeenCalledWith({
      type: 'governance',
      config: { max_turns: 10, focus_brain_views: ['technical'] },
    })
  })

  it('returns 400 when type is missing', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when type is invalid', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'invalid-type' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 on invalid JSON', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/sessions — list
// ---------------------------------------------------------------------------

describe('GET /api/v1/sessions', () => {
  it('returns paginated session list with defaults', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.items).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.limit).toBe(20)
    expect(body.offset).toBe(0)
    expect(sessionService.list).toHaveBeenCalledWith(undefined, 20, 0)
  })

  it('passes status_filter to SessionService', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    await app.request('/api/v1/sessions?status_filter=active')

    expect(sessionService.list).toHaveBeenCalledWith('active', 20, 0)
  })

  it('ignores invalid status_filter', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    await app.request('/api/v1/sessions?status_filter=garbage')

    expect(sessionService.list).toHaveBeenCalledWith(undefined, 20, 0)
  })

  it('caps limit at 100', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    await app.request('/api/v1/sessions?limit=9999')

    expect(sessionService.list).toHaveBeenCalledWith(undefined, 100, 0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/sessions/:id — get session with transcript
// ---------------------------------------------------------------------------

describe('GET /api/v1/sessions/:id', () => {
  it('returns session with transcript by default', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe('session-uuid-1')
    expect(body.transcript).toHaveLength(1)
    expect(sessionService.getWithTranscript).toHaveBeenCalledWith('session-uuid-1')
  })

  it('returns session without transcript when include_transcript=false', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1?include_transcript=false')

    expect(res.status).toBe(200)
    expect(sessionService.getById).toHaveBeenCalledWith('session-uuid-1')
    expect(sessionService.getWithTranscript).not.toHaveBeenCalled()
  })

  it('returns 404 when session not found', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const sessionService = makeMockSessionService({
      getWithTranscript: vi.fn().mockRejectedValue(new NotFoundError('Session not found')),
    })
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/nonexistent-id')

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/sessions/:id/respond
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/respond', () => {
  it('submits user message and returns bot response', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'I am working on the QSR project.' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.bot_message).toBeDefined()
    expect(sessionService.respond).toHaveBeenCalledWith(
      'session-uuid-1',
      'I am working on the QSR project.',
    )
  })

  it('trims whitespace from message', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    await app.request('/api/v1/sessions/session-uuid-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '  hello world  ' }),
    })

    expect(sessionService.respond).toHaveBeenCalledWith('session-uuid-1', 'hello world')
  })

  it('returns 400 when message is missing', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when message is empty string', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 on invalid JSON', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad-json',
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/sessions/:id/pause
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/pause', () => {
  it('pauses an active session', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/pause', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.session.status).toBe('paused')
    expect(sessionService.pause).toHaveBeenCalledWith('session-uuid-1')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/sessions/:id/resume
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/resume', () => {
  it('resumes a paused session and returns context message', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/resume', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.context_message).toContain('Welcome back')
    expect(sessionService.resume).toHaveBeenCalledWith('session-uuid-1')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/sessions/:id/complete
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/complete', () => {
  it('completes an active session and returns summary', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/complete', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.session.status).toBe('complete')
    expect(body.summary).toBe('Session completed.')
    expect(sessionService.complete).toHaveBeenCalledWith('session-uuid-1')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/sessions/:id/abandon
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/abandon', () => {
  it('abandons a session', async () => {
    const sessionService = makeMockSessionService()
    const app = createApp({ sessionService })

    const res = await app.request('/api/v1/sessions/session-uuid-1/abandon', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.session.status).toBe('abandoned')
    expect(sessionService.abandon).toHaveBeenCalledWith('session-uuid-1')
  })
})
