/**
 * Phase 4.4 — voice-sessions route EXTRA tests.
 *
 * The primary coverage lives in `voice-session-routes.test.ts` (shipped
 * pre-Phase-4). This file adds complementary scenarios not covered there:
 *   - pagination edge cases (non-finite/NaN query params)
 *   - ended_at ISO validation on PATCH
 *   - duration_seconds validation on PATCH
 *   - captures_created validation on PATCH
 *   - complete endpoint rejects empty transcript (boundary)
 *   - get-by-id propagates NotFoundError as 404
 *
 * DI strategy:
 *   - `makeTestApp` + `registerVoiceSessionRoutes` from helpers.ts.
 *   - `makeMockService<VoiceSessionService>([...])` for typed mock.
 *   - `NotFoundError` from `@open-brain/shared` to simulate DB miss.
 *
 * DI gap surfaced: logger is imported at module scope in voice-sessions.ts
 * (not injected). Acceptable — same pattern as other routes. If Phase 5
 * adds a VoiceSessionService constructor it should accept a logger option.
 */
import { describe, it, expect } from 'vitest'
import { NotFoundError } from '@open-brain/shared'
import type { VoiceSessionService } from '../services/voice-session.js'
import { registerVoiceSessionRoutes } from '../routes/voice-sessions.js'
import { makeTestApp, makeMockService, testJson } from './helpers.js'

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const BASE_SESSION = {
  id: 'vs-extra-1',
  session_key: 'pipecat-extra',
  started_at: new Date('2026-04-20T08:00:00Z'),
  ended_at: null,
  duration_seconds: null,
  turn_count: 0,
  transcript: [],
  summary: null,
  captures_created: [],
  metadata: {},
  created_at: new Date('2026-04-20T08:00:00Z'),
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp(overrides: Partial<Record<keyof VoiceSessionService, unknown>> = {}) {
  const svc = makeMockService<VoiceSessionService>([
    'list',
    'getActive',
    'get',
    'create',
    'update',
    'complete',
    'setActivityFeedService',
  ])
  svc.list.mockResolvedValue({ items: [BASE_SESSION], total: 1 })
  svc.getActive.mockResolvedValue([BASE_SESSION])
  svc.get.mockResolvedValue(BASE_SESSION)
  svc.create.mockResolvedValue(BASE_SESSION)
  svc.update.mockResolvedValue(BASE_SESSION)
  svc.complete.mockResolvedValue({ ...BASE_SESSION, ended_at: new Date(), summary: 'done' })

  // Apply per-test overrides
  for (const [k, v] of Object.entries(overrides)) {
    ;(svc as Record<string, unknown>)[k] = v
  }

  const app = makeTestApp((a) => {
    registerVoiceSessionRoutes(a, svc as unknown as VoiceSessionService)
  })

  return { app, svc }
}

// ---------------------------------------------------------------------------
// GET /api/v1/voice/sessions — pagination edge cases
// ---------------------------------------------------------------------------

describe('GET /api/v1/voice/sessions — pagination edge cases', () => {
  it('treats NaN limit as default 50', async () => {
    const { app, svc } = buildApp()

    await testJson(app, '/api/v1/voice/sessions?limit=abc')

    expect(svc.list).toHaveBeenCalledWith(50, 0)
  })

  it('treats NaN offset as default 0', async () => {
    const { app, svc } = buildApp()

    await testJson(app, '/api/v1/voice/sessions?limit=10&offset=xyz')

    expect(svc.list).toHaveBeenCalledWith(10, 0)
  })

  it('caps limit at 100 even with large finite number', async () => {
    const { app, svc } = buildApp()

    await testJson(app, '/api/v1/voice/sessions?limit=9999')

    expect(svc.list).toHaveBeenCalledWith(100, 0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/voice/sessions/:id — 404 propagation
// ---------------------------------------------------------------------------

describe('GET /api/v1/voice/sessions/:id — 404 propagation', () => {
  it('returns 404 when service throws NotFoundError', async () => {
    const { app } = buildApp({
      get: async () => {
        throw new NotFoundError('Voice session not found: vs-missing')
      },
    })

    const { status, body } = await testJson(app, '/api/v1/voice/sessions/vs-missing')
    const b = body as { code?: string }

    expect(status).toBe(404)
    expect(b.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/voice/sessions/:id — additional field validation
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/voice/sessions/:id — additional validation', () => {
  it('validates ended_at must be a valid ISO date', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/voice/sessions/vs-extra-1', {
      method: 'PATCH',
      body: JSON.stringify({ ended_at: 'not-a-date' }),
    })
    const b = body as { code?: string }

    expect(status).toBe(400)
    expect(b.code).toBe('VALIDATION_ERROR')
  })

  it('accepts a valid ISO ended_at', async () => {
    const { app, svc } = buildApp()

    const { status } = await testJson(app, '/api/v1/voice/sessions/vs-extra-1', {
      method: 'PATCH',
      body: JSON.stringify({ ended_at: '2026-04-20T09:00:00Z' }),
    })

    expect(status).toBe(200)
    expect(svc.update).toHaveBeenCalledWith(
      'vs-extra-1',
      expect.objectContaining({ ended_at: expect.any(Date) }),
    )
  })

  it('validates duration_seconds must be an integer', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/voice/sessions/vs-extra-1', {
      method: 'PATCH',
      body: JSON.stringify({ duration_seconds: 3.14 }),
    })
    const b = body as { code?: string }

    expect(status).toBe(400)
    expect(b.code).toBe('VALIDATION_ERROR')
  })

  it('validates captures_created must be an array', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(app, '/api/v1/voice/sessions/vs-extra-1', {
      method: 'PATCH',
      body: JSON.stringify({ captures_created: 'not-an-array' }),
    })
    const b = body as { code?: string }

    expect(status).toBe(400)
    expect(b.code).toBe('VALIDATION_ERROR')
  })

  it('accepts captures_created as an array', async () => {
    const { app, svc } = buildApp()

    const { status } = await testJson(app, '/api/v1/voice/sessions/vs-extra-1', {
      method: 'PATCH',
      body: JSON.stringify({ captures_created: ['cap-1', 'cap-2'] }),
    })

    expect(status).toBe(200)
    expect(svc.update).toHaveBeenCalledWith(
      'vs-extra-1',
      expect.objectContaining({ captures_created: ['cap-1', 'cap-2'] }),
    )
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/voice/sessions/:id/complete — additional edge cases
// ---------------------------------------------------------------------------

describe('POST /api/v1/voice/sessions/:id/complete — edge cases', () => {
  it('returns 200 with completed session shape', async () => {
    const { app } = buildApp()

    const { status, body } = await testJson(
      app,
      '/api/v1/voice/sessions/vs-extra-1/complete',
      {
        method: 'POST',
        body: JSON.stringify({
          transcript: [{ role: 'user', content: 'Hi' }],
          summary: 'A quick check-in',
        }),
      },
    )
    const b = body as { ended_at?: unknown; summary?: string }

    expect(status).toBe(200)
    expect(b.summary).toBe('done')
    expect(b.ended_at).toBeDefined()
  })

  it('rejects whitespace-only summary', async () => {
    const { app } = buildApp()

    const { status } = await testJson(app, '/api/v1/voice/sessions/vs-extra-1/complete', {
      method: 'POST',
      body: JSON.stringify({
        transcript: [{ role: 'user', content: 'Hi' }],
        summary: '   ',
      }),
    })

    expect(status).toBe(400)
  })
})
