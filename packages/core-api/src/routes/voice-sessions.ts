import type { Hono } from 'hono'
import { ValidationError, logger } from '@open-brain/shared'
import type { VoiceSessionService, TranscriptTurn } from '../services/voice-session.js'
import { parseUUIDParam } from '../lib/validation.js'

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
    const id = parseUUIDParam(c.req.param('id'))
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
      throw new ValidationError('Invalid JSON body')
    }

    const sessionKey = body.session_key
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) {
      throw new ValidationError('Missing or invalid "session_key" field')
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
    const id = parseUUIDParam(c.req.param('id'))

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      throw new ValidationError('Invalid JSON body')
    }

    const updateData: Record<string, unknown> = {}

    if (body.transcript !== undefined) {
      if (!Array.isArray(body.transcript)) {
        throw new ValidationError('"transcript" must be an array')
      }
      updateData.transcript = body.transcript as TranscriptTurn[]
    }

    if (body.turn_count !== undefined) {
      if (typeof body.turn_count !== 'number' || !Number.isInteger(body.turn_count)) {
        throw new ValidationError('"turn_count" must be an integer')
      }
      updateData.turn_count = body.turn_count
    }

    if (body.summary !== undefined) {
      if (typeof body.summary !== 'string') {
        throw new ValidationError('"summary" must be a string')
      }
      updateData.summary = body.summary
    }

    if (body.captures_created !== undefined) {
      if (!Array.isArray(body.captures_created)) {
        throw new ValidationError('"captures_created" must be an array')
      }
      updateData.captures_created = body.captures_created
    }

    if (body.metadata !== undefined) {
      if (typeof body.metadata !== 'object' || body.metadata === null) {
        throw new ValidationError('"metadata" must be an object')
      }
      updateData.metadata = body.metadata
    }

    if (body.ended_at !== undefined) {
      const d = new Date(body.ended_at as string)
      if (isNaN(d.getTime())) {
        throw new ValidationError('"ended_at" must be a valid ISO date')
      }
      updateData.ended_at = d
    }

    if (body.duration_seconds !== undefined) {
      if (typeof body.duration_seconds !== 'number' || !Number.isInteger(body.duration_seconds)) {
        throw new ValidationError('"duration_seconds" must be an integer')
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
    const id = parseUUIDParam(c.req.param('id'))

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      throw new ValidationError('Invalid JSON body')
    }

    const { transcript, summary, capture_ids } = body as {
      transcript?: TranscriptTurn[]
      summary?: string
      capture_ids?: string[]
    }

    if (!Array.isArray(transcript)) {
      throw new ValidationError('"transcript" is required and must be an array')
    }
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new ValidationError('"summary" is required and must be a non-empty string')
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
