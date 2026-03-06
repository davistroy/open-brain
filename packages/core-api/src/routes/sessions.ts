import type { Hono } from 'hono'
import { ValidationError, NotFoundError } from '@open-brain/shared'
import type { SessionService, SessionType, SessionStatus } from '../services/session.js'
import { logger } from '../lib/logger.js'

/**
 * Register session management API routes.
 *
 * POST /api/v1/sessions                  — create session (type required)
 * GET  /api/v1/sessions                  — list sessions (status_filter, limit, offset)
 * GET  /api/v1/sessions/:id              — get session state + full transcript
 * POST /api/v1/sessions/:id/respond      — submit user message, receive bot response
 * POST /api/v1/sessions/:id/pause        — pause active session
 * POST /api/v1/sessions/:id/resume       — resume paused session
 * POST /api/v1/sessions/:id/complete     — complete session + generate summary
 * POST /api/v1/sessions/:id/abandon      — abandon session
 */
export function registerSessionRoutes(app: Hono, sessionService: SessionService): void {
  const VALID_TYPES: SessionType[] = ['governance', 'review', 'planning']
  const VALID_STATUSES: SessionStatus[] = ['active', 'paused', 'complete', 'abandoned']

  // -------------------------------------------------------------------------
  // POST /api/v1/sessions — create session
  // Body: { type: SessionType, config?: { max_turns?, timeout_ms?, focus_brain_views? } }
  // -------------------------------------------------------------------------
  app.post('/api/v1/sessions', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { type, config } = body as {
      type?: string
      config?: {
        max_turns?: number
        timeout_ms?: number
        focus_brain_views?: string[]
      }
    }

    if (!type || !VALID_TYPES.includes(type as SessionType)) {
      return c.json(
        {
          error: `type is required and must be one of: ${VALID_TYPES.join(', ')}`,
          code: 'VALIDATION_ERROR',
        },
        400,
      )
    }

    logger.info({ type }, '[sessions-api] creating session')

    const result = await sessionService.create({
      type: type as SessionType,
      config,
    })

    return c.json(
      {
        session: result.session,
        first_message: result.first_message,
      },
      201,
    )
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/sessions — list sessions
  // Query params: status_filter, limit (default 20, max 100), offset (default 0)
  // -------------------------------------------------------------------------
  app.get('/api/v1/sessions', async (c) => {
    const statusRaw = c.req.query('status_filter')
    const limitRaw = c.req.query('limit')
    const offsetRaw = c.req.query('offset')

    const statusFilter = statusRaw && VALID_STATUSES.includes(statusRaw as SessionStatus)
      ? (statusRaw as SessionStatus)
      : undefined

    const limit = Math.min(Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 20, 100)
    const offset = Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : 0

    const result = await sessionService.list(statusFilter, limit, offset)

    return c.json({
      items: result.items,
      total: result.total,
      limit,
      offset,
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/sessions/:id — get session state + transcript
  // -------------------------------------------------------------------------
  app.get('/api/v1/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const withTranscript = c.req.query('include_transcript') !== 'false'

    if (withTranscript) {
      const result = await sessionService.getWithTranscript(id)
      return c.json(result)
    }

    const session = await sessionService.getById(id)
    return c.json(session)
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/sessions/:id/respond — submit user message
  // Body: { message: string }
  // -------------------------------------------------------------------------
  app.post('/api/v1/sessions/:id/respond', async (c) => {
    const id = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { message } = body as { message?: string }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return c.json({ error: 'message is required and must be a non-empty string', code: 'VALIDATION_ERROR' }, 400)
    }

    logger.info({ sessionId: id, messageLen: message.length }, '[sessions-api] processing respond')

    const result = await sessionService.respond(id, message.trim())

    return c.json({
      session: result.session,
      bot_message: result.bot_message,
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/sessions/:id/pause
  // -------------------------------------------------------------------------
  app.post('/api/v1/sessions/:id/pause', async (c) => {
    const id = c.req.param('id')

    logger.info({ sessionId: id }, '[sessions-api] pausing session')

    const session = await sessionService.pause(id)

    return c.json({ session })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/sessions/:id/resume
  // -------------------------------------------------------------------------
  app.post('/api/v1/sessions/:id/resume', async (c) => {
    const id = c.req.param('id')

    logger.info({ sessionId: id }, '[sessions-api] resuming session')

    const result = await sessionService.resume(id)

    return c.json({
      session: result.session,
      context_message: result.context_message,
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/sessions/:id/complete
  // -------------------------------------------------------------------------
  app.post('/api/v1/sessions/:id/complete', async (c) => {
    const id = c.req.param('id')

    logger.info({ sessionId: id }, '[sessions-api] completing session')

    const result = await sessionService.complete(id)

    return c.json({
      session: result.session,
      summary: result.summary,
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/sessions/:id/abandon
  // -------------------------------------------------------------------------
  app.post('/api/v1/sessions/:id/abandon', async (c) => {
    const id = c.req.param('id')

    logger.info({ sessionId: id }, '[sessions-api] abandoning session')

    const session = await sessionService.abandon(id)

    return c.json({ session })
  })
}
