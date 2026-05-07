/**
 * Unit tests for the briefs routes (`packages/core-api/src/routes/briefs.ts`).
 *
 * Phase 3.6 (briefs half) of IMPLEMENTATION_PLAN-ARCH-REVIEW.md. Mounts the
 * route directly via `registerBriefRoutes` inside `makeTestApp` so the
 * fixture is self-contained and does not bootstrap the full createApp()
 * with its `pg` / `ioredis` / `fetch` mocks.
 *
 * The TTS endpoint (POST /api/v1/briefs/:id/audio) is intentionally NOT
 * exercised here — those paths require a Database/Redis/fetch surface
 * that's better covered by the existing `brief-tts.test.ts` fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError } from '@open-brain/shared'
import type { BriefsService, BriefDetailItem, BriefListItem, BriefListResult } from '../services/briefs.js'
import { registerBriefRoutes } from '../routes/briefs.js'
import { makeMockService, makeTestApp, testJson } from './helpers.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A UUID that looks valid but the mock service will reject with NotFoundError */
const MISSING_BRIEF_ID = '99999999-9999-9999-9999-999999999999'

const SAMPLE_LIST_ITEM: BriefListItem = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'WEEKLY',
  cover: 'cover-url',
  title: 'Weekly Brief — 2026-W18',
  subtitle: '6 captures synthesized',
  source_skill_log_id: null,
  refined_from_id: null,
  generated_at: '2026-05-04T08:00:00.000Z',
  read_at: null,
  dismissed_at: null,
  created_at: '2026-05-04T08:00:00.000Z',
  updated_at: '2026-05-04T08:00:00.000Z',
}

const SAMPLE_DETAIL_ITEM: BriefDetailItem = {
  ...SAMPLE_LIST_ITEM,
  body_html: '<h1>Brief</h1><p>Body</p>',
  toc: [{ heading: 'Brief', anchor: 'brief' }],
  sources: [{ capture_id: 'cap-1', title: 'Source capture' }],
  refine_options: ['Shorter', 'More formal'],
}

const SAMPLE_LIST_RESULT: BriefListResult = {
  items: [SAMPLE_LIST_ITEM],
  total: 1,
  limit: 20,
  offset: 0,
}

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

function buildApp(briefsService: ReturnType<typeof makeMockService<BriefsService>>) {
  return makeTestApp((app) => {
    registerBriefRoutes(app, briefsService as unknown as BriefsService)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('briefs routes', () => {
  let briefsService: ReturnType<typeof makeMockService<BriefsService>>

  beforeEach(() => {
    vi.clearAllMocks()
    briefsService = makeMockService<BriefsService>([
      'list',
      'getById',
      'create',
      'refine',
      'dismiss',
      'patchRead',
    ])
    briefsService.list.mockResolvedValue(SAMPLE_LIST_RESULT)
    briefsService.getById.mockResolvedValue(SAMPLE_DETAIL_ITEM)
    briefsService.refine.mockResolvedValue({ job_id: 'job-1', status: 'queued' })
    briefsService.dismiss.mockResolvedValue(undefined)
    briefsService.patchRead.mockResolvedValue(SAMPLE_LIST_ITEM)
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/briefs (pagination)
  // -------------------------------------------------------------------------

  describe('GET /api/v1/briefs', () => {
    it('passes limit and offset to BriefsService.list and returns 200 with the canonical shape', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(app, '/api/v1/briefs?limit=5&offset=0')

      expect(status).toBe(200)
      expect(body).toEqual(SAMPLE_LIST_RESULT)
      expect(briefsService.list).toHaveBeenCalledWith({
        kind: undefined,
        unread: undefined,
        limit: 5,
        offset: 0,
      })
    })

    it('uses default limit (20) and offset (0) when query params are absent', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(app, '/api/v1/briefs')

      expect(status).toBe(200)
      expect(briefsService.list).toHaveBeenCalledWith({
        kind: undefined,
        unread: undefined,
        limit: 20,
        offset: 0,
      })
    })

    it('clamps limit to the 1..100 range (request limit=999 → service receives 100)', async () => {
      // The schema's transform clamps via Math.min(Math.max(n,1),100). This
      // documents the actual behavior (no 400) so a future regression that
      // makes the route REJECT > 100 will surface here as a deliberate choice.
      const app = buildApp(briefsService)
      const { status } = await testJson(app, '/api/v1/briefs?limit=999')

      expect(status).toBe(200)
      expect(briefsService.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      )
    })

    it('clamps limit to a minimum of 1 (request limit=0 → service receives 1)', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(app, '/api/v1/briefs?limit=0')

      expect(status).toBe(200)
      expect(briefsService.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      )
    })

    it('rejects an invalid kind value (Zod enum) with 400', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(app, '/api/v1/briefs?kind=BOGUS')

      expect(status).toBe(400)
      expect(briefsService.list).not.toHaveBeenCalled()
    })

    it('passes kind=WEEKLY and unread=true through to the service', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(app, '/api/v1/briefs?kind=WEEKLY&unread=true')

      expect(status).toBe(200)
      expect(briefsService.list).toHaveBeenCalledWith({
        kind: 'WEEKLY',
        unread: true,
        limit: 20,
        offset: 0,
      })
    })

    it('translates unread=false → service receives unread:undefined (route uses ||)', async () => {
      // Route logic: `unread: query.unread || undefined` — explicit "false"
      // becomes undefined, matching the service's "unread filter only when truthy".
      const app = buildApp(briefsService)
      const { status } = await testJson(app, '/api/v1/briefs?unread=false')

      expect(status).toBe(200)
      expect(briefsService.list).toHaveBeenCalledWith(
        expect.objectContaining({ unread: undefined }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/briefs/:id (detail lookup)
  // -------------------------------------------------------------------------

  describe('GET /api/v1/briefs/:id', () => {
    it('returns 200 with {brief: ...} for a real ID', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_DETAIL_ITEM.id}`,
      )

      expect(status).toBe(200)
      expect(body).toEqual({ brief: SAMPLE_DETAIL_ITEM })
      expect(briefsService.getById).toHaveBeenCalledWith(SAMPLE_DETAIL_ITEM.id)
    })

    it('propagates NotFoundError as 404 with NOT_FOUND code', async () => {
      briefsService.getById.mockRejectedValueOnce(
        new NotFoundError(`Brief not found: ${MISSING_BRIEF_ID}`),
      )
      const app = buildApp(briefsService)

      const { status, body } = await testJson(app, `/api/v1/briefs/${MISSING_BRIEF_ID}`)

      expect(status).toBe(404)
      expect(body).toEqual({
        error: `Brief not found: ${MISSING_BRIEF_ID}`,
        code: 'NOT_FOUND',
      })
    })

    it('returns 500 + INTERNAL_ERROR when the service throws an unexpected error', async () => {
      briefsService.getById.mockRejectedValueOnce(new Error('db blew up'))
      const app = buildApp(briefsService)

      const { status, body } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_DETAIL_ITEM.id}`,
      )

      expect(status).toBe(500)
      expect(body).toEqual({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      })
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/refine (trigger / regenerate path)
  // -------------------------------------------------------------------------

  describe('POST /api/v1/briefs/:id/refine', () => {
    it('returns 202 + {job_id, status} on a happy path', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_DETAIL_ITEM.id}/refine`,
        {
          method: 'POST',
          body: JSON.stringify({ option: 'Shorter' }),
        },
      )

      expect(status).toBe(202)
      expect(body).toEqual({ job_id: 'job-1', status: 'queued' })
      expect(briefsService.refine).toHaveBeenCalledWith(
        SAMPLE_DETAIL_ITEM.id,
        'Shorter',
      )
    })

    it('returns 400 when option is empty (Zod min(1))', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_DETAIL_ITEM.id}/refine`,
        {
          method: 'POST',
          body: JSON.stringify({ option: '' }),
        },
      )

      expect(status).toBe(400)
      expect(briefsService.refine).not.toHaveBeenCalled()
    })

    it('returns 400 when option is missing entirely', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_DETAIL_ITEM.id}/refine`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      )

      expect(status).toBe(400)
      expect(briefsService.refine).not.toHaveBeenCalled()
    })

    it('returns 404 when the source brief does not exist (NotFoundError from service)', async () => {
      briefsService.refine.mockRejectedValueOnce(
        new NotFoundError(`Brief not found: ${MISSING_BRIEF_ID}`),
      )
      const app = buildApp(briefsService)

      const { status, body } = await testJson(app, `/api/v1/briefs/${MISSING_BRIEF_ID}/refine`, {
        method: 'POST',
        body: JSON.stringify({ option: 'Shorter' }),
      })

      expect(status).toBe(404)
      expect(body).toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/dismiss
  // -------------------------------------------------------------------------

  describe('POST /api/v1/briefs/:id/dismiss', () => {
    it('returns 204 with no body on success', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_DETAIL_ITEM.id}/dismiss`,
        { method: 'POST' },
      )

      expect(status).toBe(204)
      expect(body).toBeNull()
      expect(briefsService.dismiss).toHaveBeenCalledWith(SAMPLE_DETAIL_ITEM.id)
    })

    it('propagates NotFoundError as 404 when the brief does not exist', async () => {
      briefsService.dismiss.mockRejectedValueOnce(
        new NotFoundError(`Brief not found: ${MISSING_BRIEF_ID}`),
      )
      const app = buildApp(briefsService)

      const { status } = await testJson(app, `/api/v1/briefs/${MISSING_BRIEF_ID}/dismiss`, {
        method: 'POST',
      })

      expect(status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /api/v1/briefs/:id (read/unread toggle)
  // -------------------------------------------------------------------------

  describe('PATCH /api/v1/briefs/:id', () => {
    it('returns 200 with {brief: ...} when toggling read=true', async () => {
      briefsService.patchRead.mockResolvedValueOnce({
        ...SAMPLE_LIST_ITEM,
        read_at: '2026-05-04T09:00:00.000Z',
      })
      const app = buildApp(briefsService)

      const { status, body } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_LIST_ITEM.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ read: true }),
        },
      )

      expect(status).toBe(200)
      expect(body).toMatchObject({
        brief: { id: SAMPLE_LIST_ITEM.id, read_at: '2026-05-04T09:00:00.000Z' },
      })
      expect(briefsService.patchRead).toHaveBeenCalledWith(SAMPLE_LIST_ITEM.id, true)
    })

    it('returns 400 when read field is missing', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_LIST_ITEM.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({}),
        },
      )

      expect(status).toBe(400)
      expect(briefsService.patchRead).not.toHaveBeenCalled()
    })

    it('returns 400 when read is the wrong type (string instead of boolean)', async () => {
      const app = buildApp(briefsService)
      const { status } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_LIST_ITEM.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ read: 'yes' }),
        },
      )

      expect(status).toBe(400)
      expect(briefsService.patchRead).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/audio — TTS deps absent
  // -------------------------------------------------------------------------

  describe('POST /api/v1/briefs/:id/audio (no TTS deps)', () => {
    it('returns 503 + SERVICE_UNAVAILABLE when ttsDeps is not provided', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_LIST_ITEM.id}/audio`,
        { method: 'POST' },
      )

      expect(status).toBe(503)
      expect(body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    })
  })

  // -------------------------------------------------------------------------
  // A113 — UUID path-param validation
  // -------------------------------------------------------------------------

  describe('A113 — UUID validation on briefs /:id path params', () => {
    it('GET /api/v1/briefs/:id rejects non-UUID with 400 VALIDATION_ERROR', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(app, '/api/v1/briefs/not-a-uuid')

      expect(status).toBe(400)
      expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
      expect((body as { error: string }).error).toContain('must be a valid UUID')
      expect(briefsService.getById).not.toHaveBeenCalled()
    })

    it('POST /api/v1/briefs/:id/dismiss rejects non-UUID with 400 VALIDATION_ERROR', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(app, '/api/v1/briefs/bad-id/dismiss', {
        method: 'POST',
      })

      expect(status).toBe(400)
      expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
      expect(briefsService.dismiss).not.toHaveBeenCalled()
    })

    it('PATCH /api/v1/briefs/:id with non-UUID rejects 400', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(app, '/api/v1/briefs/not-a-uuid', {
        method: 'PATCH',
        body: JSON.stringify({ read: true }),
      })

      expect(status).toBe(400)
      expect((body as { code: string }).code).toBe('VALIDATION_ERROR')
      expect(briefsService.patchRead).not.toHaveBeenCalled()
    })

    it('GET /api/v1/briefs/:id with valid UUID proceeds to service call', async () => {
      const app = buildApp(briefsService)
      const { status, body } = await testJson(
        app,
        `/api/v1/briefs/${SAMPLE_DETAIL_ITEM.id}`,
      )

      expect(status).toBe(200)
      expect((body as { brief: { id: string } }).brief.id).toBe(SAMPLE_DETAIL_ITEM.id)
      expect(briefsService.getById).toHaveBeenCalledWith(SAMPLE_DETAIL_ITEM.id)
    })
  })
})
