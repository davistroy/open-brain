/**
 * Sessions route tests — Phase 3.5 of IMPLEMENTATION_PLAN-ARCH-REVIEW.md.
 *
 * Focus: VALID_TYPES + VALID_STATUSES enum enforcement, status-transition
 * validation, list pagination + filter sanitization, 404 propagation.
 *
 * Complements `session-routes.test.ts` (which covers happy-path lifecycle
 * verbs against `createApp`). This file uses the shared helpers from
 * `helpers.ts` and mounts `registerSessionRoutes` directly — the route
 * boundary, not the whole app — so we can exercise validation behavior
 * without dragging in pg/redis/ioredis stubs.
 *
 * Status-transition rules under test (enforced inside SessionService — the
 * route delegates, so we mirror the rejection behavior by having the mocked
 * service reject with ValidationError, the contract the route promises):
 *   - terminal → active rejected (`complete` and `abandoned`)
 *   - active   → paused   accepted
 *   - paused   → active   accepted (resume)
 *   - active   → complete accepted
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { NotFoundError, ValidationError } from '@open-brain/shared'
import { registerSessionRoutes } from '../routes/sessions.js'
import type { SessionService } from '../services/session.js'
import { DEFAULT_HEADERS, makeMockService, makeTestApp, testJson } from './helpers.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    session_type: 'governance',
    status: 'active',
    config: { max_turns: 20, turn_count: 0 },
    context_capture_ids: [],
    summary: null,
    created_at: new Date('2026-05-05T10:00:00Z'),
    updated_at: new Date('2026-05-05T10:00:00Z'),
    completed_at: null,
    ...overrides,
  }
}

const SESSION_SERVICE_METHODS = [
  'create',
  'list',
  'getById',
  'getWithTranscript',
  'respond',
  'pause',
  'resume',
  'complete',
  'abandon',
  'getTranscript',
] as const satisfies ReadonlyArray<keyof SessionService>

function buildApp() {
  const sessionService = makeMockService<SessionService>(SESSION_SERVICE_METHODS)
  const app = makeTestApp((a) => {
    registerSessionRoutes(a, sessionService as unknown as SessionService)
  })
  return { app, sessionService }
}

// ---------------------------------------------------------------------------
// Type enum enforcement (POST /api/v1/sessions)
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions — VALID_TYPES enum enforcement', () => {
  let env: ReturnType<typeof buildApp>

  beforeEach(() => {
    env = buildApp()
    env.sessionService.create.mockImplementation(async ({ type }) => ({
      session: makeSession({ session_type: type }),
      first_message: 'opening',
    }))
  })

  it.each(['governance', 'review', 'planning'] as const)(
    'accepts valid type=%s and returns 201',
    async (type) => {
      const { status, body } = await testJson(env.app, '/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ type }),
      })
      expect(status).toBe(201)
      expect((body as { session: { session_type: string } }).session.session_type).toBe(type)
      expect(env.sessionService.create).toHaveBeenCalledWith({ type, config: undefined })
    },
  )

  it('rejects type="invalid" with 400 ValidationError', async () => {
    const { status, body } = await testJson(env.app, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ type: 'invalid' }),
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
    expect(env.sessionService.create).not.toHaveBeenCalled()
  })

  it('rejects missing type with 400 ValidationError', async () => {
    const { status, body } = await testJson(env.app, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
  })

  it('rejects malformed JSON with 400 ValidationError', async () => {
    const { status } = await testJson(env.app, '/api/v1/sessions', {
      method: 'POST',
      body: 'not-json',
    })
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Status enum enforcement (GET /api/v1/sessions?status_filter=...)
// ---------------------------------------------------------------------------

describe('GET /api/v1/sessions — VALID_STATUSES filter sanitization', () => {
  let env: ReturnType<typeof buildApp>

  beforeEach(() => {
    env = buildApp()
    env.sessionService.list.mockResolvedValue({ items: [makeSession()], total: 1 })
  })

  it.each(['active', 'paused', 'complete', 'abandoned'] as const)(
    'forwards valid status_filter=%s to SessionService.list',
    async (status) => {
      const res = await env.app.request(`/api/v1/sessions?status_filter=${status}`, {
        headers: DEFAULT_HEADERS,
      })
      expect(res.status).toBe(200)
      expect(env.sessionService.list).toHaveBeenCalledWith(status, 20, 0)
    },
  )

  it('drops invalid status_filter="cancelled" silently (passes undefined)', async () => {
    const res = await env.app.request('/api/v1/sessions?status_filter=cancelled', {
      headers: DEFAULT_HEADERS,
    })
    expect(res.status).toBe(200)
    expect(env.sessionService.list).toHaveBeenCalledWith(undefined, 20, 0)
  })

  it('caps limit at 100 and applies offset', async () => {
    const res = await env.app.request('/api/v1/sessions?limit=9999&offset=50', {
      headers: DEFAULT_HEADERS,
    })
    expect(res.status).toBe(200)
    expect(env.sessionService.list).toHaveBeenCalledWith(undefined, 100, 50)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/sessions/:id — fetch + 404 propagation
// ---------------------------------------------------------------------------

describe('GET /api/v1/sessions/:id', () => {
  it('returns the session record + transcript by default', async () => {
    const { app, sessionService } = buildApp()
    sessionService.getWithTranscript.mockResolvedValue({
      ...makeSession(),
      transcript: [],
    })

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}`)
    expect(status).toBe(200)
    expect((body as { id: string }).id).toBe(SESSION_ID)
    expect(sessionService.getWithTranscript).toHaveBeenCalledWith(SESSION_ID)
  })

  it('returns 404 + NotFoundError code when session not found', async () => {
    const { app, sessionService } = buildApp()
    sessionService.getWithTranscript.mockRejectedValue(
      new NotFoundError('Session not found: nonexistent'),
    )

    const { status, body } = await testJson(app, '/api/v1/sessions/nonexistent')
    expect(status).toBe(404)
    expect((body as { code: string }).code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// Status transitions — terminal states reject re-activation
// ---------------------------------------------------------------------------

describe('Status transitions — terminal-state guards', () => {
  it('rejects resume() on a complete session (complete → active forbidden)', async () => {
    const { app, sessionService } = buildApp()
    sessionService.resume.mockRejectedValue(
      new ValidationError(
        `Session ${SESSION_ID} is complete — only paused sessions can be resumed`,
      ),
    )

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/resume`, {
      method: 'POST',
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
  })

  it('rejects resume() on an abandoned session (abandoned → active forbidden)', async () => {
    const { app, sessionService } = buildApp()
    sessionService.resume.mockRejectedValue(
      new ValidationError(
        `Session ${SESSION_ID} is abandoned — only paused sessions can be resumed`,
      ),
    )

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/resume`, {
      method: 'POST',
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
  })

  it('rejects abandon() on a complete session (complete is terminal-success)', async () => {
    const { app, sessionService } = buildApp()
    sessionService.abandon.mockRejectedValue(
      new ValidationError(`Session ${SESSION_ID} is already complete — cannot abandon`),
    )

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/abandon`, {
      method: 'POST',
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
  })

  it('rejects respond() on a paused session (only active accepts respond)', async () => {
    const { app, sessionService } = buildApp()
    sessionService.respond.mockRejectedValue(
      new ValidationError(
        `Session ${SESSION_ID} is paused — cannot respond to a non-active session`,
      ),
    )

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/respond`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// Status transitions — accepted moves
// ---------------------------------------------------------------------------

describe('Status transitions — accepted moves', () => {
  it('active → paused via POST /pause', async () => {
    const { app, sessionService } = buildApp()
    sessionService.pause.mockResolvedValue(makeSession({ status: 'paused' }))

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/pause`, {
      method: 'POST',
    })
    expect(status).toBe(200)
    expect((body as { session: { status: string } }).session.status).toBe('paused')
    expect(sessionService.pause).toHaveBeenCalledWith(SESSION_ID)
  })

  it('paused → active via POST /resume', async () => {
    const { app, sessionService } = buildApp()
    sessionService.resume.mockResolvedValue({
      session: makeSession({ status: 'active' }),
      context_message: 'Welcome back. This session was paused 2 hours ago.',
    })

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/resume`, {
      method: 'POST',
    })
    expect(status).toBe(200)
    expect((body as { session: { status: string } }).session.status).toBe('active')
    expect((body as { context_message: string }).context_message).toContain('Welcome back')
  })

  it('active → complete via POST /complete', async () => {
    const { app, sessionService } = buildApp()
    sessionService.complete.mockResolvedValue({
      session: makeSession({ status: 'complete', summary: 'done.' }),
      summary: 'done.',
    })

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/complete`, {
      method: 'POST',
    })
    expect(status).toBe(200)
    expect((body as { session: { status: string } }).session.status).toBe('complete')
    expect((body as { summary: string }).summary).toBe('done.')
  })

  it('active → abandoned via POST /abandon', async () => {
    const { app, sessionService } = buildApp()
    sessionService.abandon.mockResolvedValue(makeSession({ status: 'abandoned' }))

    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/abandon`, {
      method: 'POST',
    })
    expect(status).toBe(200)
    expect((body as { session: { status: string } }).session.status).toBe('abandoned')
  })
})

// ---------------------------------------------------------------------------
// Respond message validation
// ---------------------------------------------------------------------------

describe('POST /api/v1/sessions/:id/respond — message validation', () => {
  it('returns 400 when message is missing', async () => {
    const { app, sessionService } = buildApp()
    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/respond`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
    expect(sessionService.respond).not.toHaveBeenCalled()
  })

  it('returns 400 when message is whitespace-only (route trims and length-checks)', async () => {
    const { app, sessionService } = buildApp()
    const { status, body } = await testJson(app, `/api/v1/sessions/${SESSION_ID}/respond`, {
      method: 'POST',
      body: JSON.stringify({ message: '   ' }),
    })
    expect(status).toBe(400)
    expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
    expect(sessionService.respond).not.toHaveBeenCalled()
  })
})
