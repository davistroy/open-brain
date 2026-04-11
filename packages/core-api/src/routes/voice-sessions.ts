import type { Hono } from 'hono'
import { logger } from '@open-brain/shared'
import type { VoiceSessionService, TranscriptTurn } from '../services/voice-session.js'

/**
 * Register voice session API routes.
 *
 * GET    /api/v1/voice/sessions           — list sessions (paginated)
 * GET    /api/v1/voice/sessions/active     — get active (not-yet-ended) sessions
 * GET    /api/v1/voice/sessions/:id        — get single session with transcript
 * POST   /api/v1/voice/sessions            — create new session (Pipecat calls this)
 * PATCH  /api/v1/voice/sessions/:id        — update session (Pipecat calls this)
 * POST   /api/v1/voice/sessions/:id/complete — complete session with transcript + summary
 */
export function registerVoiceSessionRoutes(
  app: Hono,
  voiceSessionService: VoiceSessionService,
): void {
  // -----------------------------------------------------------------------
  // GET /api/v1/voice/sessions — list sessions
  // Query: ?limit=50, ?offset=0
  // -----------------------------------------------------------------------
  app.get('/api/v1/voice/sessions', async (c) => {
    const limitRaw = c.req.query('limit')
    const offsetRaw = c.req.query('offset')

    const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Number(limitRaw), 100) : 50
    const offset = Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : 0

    const result = await voiceSessionService.list(limit, offset)

    return c.json({
      items: result.items,
      total: result.total,
      limit,
      offset,
    })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/voice/sessions/active — get active sessions
  // Must be registered BEFORE the :id route to avoid "active" matching as an ID.
  // -----------------------------------------------------------------------
  app.get('/api/v1/voice/sessions/active', async (c) => {
    const sessions = await voiceSessionService.getActive()
    return c.json({ items: sessions })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/voice/sessions/:id — get single session with transcript
  // -----------------------------------------------------------------------
  app.get('/api/v1/voice/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const session = await voiceSessionService.get(id)
    return c.json(session)
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/voice/sessions — create new session
  // Body: { session_key: string, metadata?: object }
  // Called by Pipecat service when a voice conversation starts.
  // -----------------------------------------------------------------------
  app.post('/api/v1/voice/sessions', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const sessionKey = body.session_key
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) {
      return c.json(
        { error: 'Missing or invalid "session_key" field', code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const metadata =
      typeof body.metadata === 'object' && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : undefined

    const session = await voiceSessionService.create({
      sessionKey: sessionKey.trim(),
      metadata,
    })

    logger.info({ sessionId: session.id, sessionKey }, '[voice-sessions-api] session created')

    return c.json(
      {
        id: session.id,
        session_key: session.session_key,
        started_at: session.started_at,
      },
      201,
    )
  })

  // -----------------------------------------------------------------------
  // PATCH /api/v1/voice/sessions/:id — update session
  // Body: { transcript?, turn_count?, summary?, captures_created?,
  //         metadata?, ended_at?, duration_seconds? }
  // Called by Pipecat service during or after a conversation.
  // -----------------------------------------------------------------------
  app.patch('/api/v1/voice/sessions/:id', async (c) => {
    const id = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const updateData: Record<string, unknown> = {}

    if (body.transcript !== undefined) {
      if (!Array.isArray(body.transcript)) {
        return c.json({ error: '"transcript" must be an array', code: 'VALIDATION_ERROR' }, 400)
      }
      updateData.transcript = body.transcript as TranscriptTurn[]
    }

    if (body.turn_count !== undefined) {
      if (typeof body.turn_count !== 'number' || !Number.isInteger(body.turn_count)) {
        return c.json({ error: '"turn_count" must be an integer', code: 'VALIDATION_ERROR' }, 400)
      }
      updateData.turn_count = body.turn_count
    }

    if (body.summary !== undefined) {
      if (typeof body.summary !== 'string') {
        return c.json({ error: '"summary" must be a string', code: 'VALIDATION_ERROR' }, 400)
      }
      updateData.summary = body.summary
    }

    if (body.captures_created !== undefined) {
      if (!Array.isArray(body.captures_created)) {
        return c.json({ error: '"captures_created" must be an array', code: 'VALIDATION_ERROR' }, 400)
      }
      updateData.captures_created = body.captures_created
    }

    if (body.metadata !== undefined) {
      if (typeof body.metadata !== 'object' || body.metadata === null) {
        return c.json({ error: '"metadata" must be an object', code: 'VALIDATION_ERROR' }, 400)
      }
      updateData.metadata = body.metadata
    }

    if (body.ended_at !== undefined) {
      const d = new Date(body.ended_at as string)
      if (isNaN(d.getTime())) {
        return c.json({ error: '"ended_at" must be a valid ISO date', code: 'VALIDATION_ERROR' }, 400)
      }
      updateData.ended_at = d
    }

    if (body.duration_seconds !== undefined) {
      if (typeof body.duration_seconds !== 'number' || !Number.isInteger(body.duration_seconds)) {
        return c.json({ error: '"duration_seconds" must be an integer', code: 'VALIDATION_ERROR' }, 400)
      }
      updateData.duration_seconds = body.duration_seconds
    }

    const session = await voiceSessionService.update(id, updateData)

    logger.info({ sessionId: id }, '[voice-sessions-api] session updated')

    return c.json(session)
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/voice/sessions/:id/complete — complete session
  // Body: { transcript: TranscriptTurn[], summary: string, capture_ids?: string[] }
  // Convenience endpoint to complete a session in one call.
  // -----------------------------------------------------------------------
  app.post('/api/v1/voice/sessions/:id/complete', async (c) => {
    const id = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { transcript, summary, capture_ids } = body as {
      transcript?: TranscriptTurn[]
      summary?: string
      capture_ids?: string[]
    }

    if (!Array.isArray(transcript)) {
      return c.json({ error: '"transcript" is required and must be an array', code: 'VALIDATION_ERROR' }, 400)
    }
    if (typeof summary !== 'string' || !summary.trim()) {
      return c.json({ error: '"summary" is required and must be a non-empty string', code: 'VALIDATION_ERROR' }, 400)
    }

    const captureIds = Array.isArray(capture_ids) ? capture_ids : []

    const session = await voiceSessionService.complete(id, transcript, summary.trim(), captureIds)

    logger.info(
      { sessionId: id, turns: transcript.length, captures: captureIds.length },
      '[voice-sessions-api] session completed',
    )

    return c.json(session)
  })
}
