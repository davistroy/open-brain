import type { Hono } from 'hono'
import { NotFoundError } from '@open-brain/shared'
import type { BetService } from '../services/bet.js'
import { logger } from '../lib/logger.js'

/**
 * Register bet tracking API routes.
 *
 * GET   /api/v1/bets          — list bets (optional ?status= filter, ?limit=, ?offset=)
 * POST  /api/v1/bets          — create a new bet
 * GET   /api/v1/bets/expiring — bets due within the next N days (default 7)
 * GET   /api/v1/bets/:id      — get a single bet
 * PATCH /api/v1/bets/:id      — resolve a bet (resolution + evidence)
 *
 * Valid resolution values: correct | incorrect | ambiguous
 * Valid status filter values: pending | correct | incorrect | ambiguous
 */
export function registerBetRoutes(app: Hono, betService: BetService): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/bets/expiring
  // Must be registered before /:id to avoid route collision.
  // Query: ?days=7 (default)
  // -------------------------------------------------------------------------
  app.get('/api/v1/bets/expiring', async (c) => {
    const daysRaw = c.req.query('days')
    const days = Number.isFinite(Number(daysRaw)) && Number(daysRaw) > 0
      ? Number(daysRaw)
      : 7

    const items = await betService.getExpiring(days)

    return c.json({ items, days_ahead: days })
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/bets
  // Query: ?status=pending|correct|incorrect|ambiguous, ?limit=20, ?offset=0
  // -------------------------------------------------------------------------
  app.get('/api/v1/bets', async (c) => {
    const status = c.req.query('status')
    const limitRaw = c.req.query('limit')
    const offsetRaw = c.req.query('offset')

    const VALID_STATUSES = ['pending', 'correct', 'incorrect', 'ambiguous'] as const
    if (status && !VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
      return c.json(
        { error: `Invalid status filter: ${status}. Valid values: ${VALID_STATUSES.join(', ')}`, code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 20
    const offset = Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : 0

    const result = await betService.list(status, limit, offset)

    return c.json({
      items: result.items,
      total: result.total,
      limit,
      offset,
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/bets
  // Body: { statement, confidence, domain?, due_date?, session_id? }
  // -------------------------------------------------------------------------
  app.post('/api/v1/bets', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { statement, confidence, domain, due_date, session_id } = body as {
      statement?: string
      confidence?: number
      domain?: string
      due_date?: string
      session_id?: string
    }

    if (!statement || typeof statement !== 'string' || statement.trim().length === 0) {
      return c.json({ error: 'statement is required', code: 'VALIDATION_ERROR' }, 400)
    }

    if (confidence === undefined || confidence === null || typeof confidence !== 'number') {
      return c.json({ error: 'confidence is required and must be a number', code: 'VALIDATION_ERROR' }, 400)
    }

    if (confidence < 0 || confidence > 1) {
      return c.json({ error: 'confidence must be between 0.0 and 1.0', code: 'VALIDATION_ERROR' }, 400)
    }

    let parsedDueDate: Date | undefined
    if (due_date) {
      parsedDueDate = new Date(due_date)
      if (Number.isNaN(parsedDueDate.getTime())) {
        return c.json({ error: 'due_date must be a valid ISO 8601 date string', code: 'VALIDATION_ERROR' }, 400)
      }
    }

    logger.info({ statement: statement.slice(0, 80), confidence }, '[bets-api] creating bet')

    const bet = await betService.create({
      statement: statement.trim(),
      confidence,
      domain: domain?.trim(),
      due_date: parsedDueDate,
      session_id: session_id?.trim(),
    })

    logger.info({ betId: bet.id }, '[bets-api] bet created')

    return c.json(bet, 201)
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/bets/:id
  // -------------------------------------------------------------------------
  app.get('/api/v1/bets/:id', async (c) => {
    const id = c.req.param('id')
    const bet = await betService.getById(id)
    return c.json(bet)
  })

  // -------------------------------------------------------------------------
  // PATCH /api/v1/bets/:id
  // Resolve a bet. Body: { resolution: 'correct'|'incorrect'|'ambiguous', evidence? }
  // Auto-captures resolution outcome as a brain 'reflection' entry.
  // -------------------------------------------------------------------------
  app.patch('/api/v1/bets/:id', async (c) => {
    const id = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { resolution, evidence } = body as {
      resolution?: string
      evidence?: string
    }

    const VALID_RESOLUTIONS = ['correct', 'incorrect', 'ambiguous'] as const
    if (!resolution || !VALID_RESOLUTIONS.includes(resolution as (typeof VALID_RESOLUTIONS)[number])) {
      return c.json(
        {
          error: `resolution is required. Valid values: ${VALID_RESOLUTIONS.join(', ')}`,
          code: 'VALIDATION_ERROR',
        },
        400,
      )
    }

    logger.info({ betId: id, resolution }, '[bets-api] resolving bet')

    const updated = await betService.resolve(id, {
      resolution: resolution as 'correct' | 'incorrect' | 'ambiguous',
      evidence: typeof evidence === 'string' ? evidence.trim() : undefined,
    })

    logger.info({ betId: id, resolution }, '[bets-api] bet resolved')

    return c.json(updated)
  })
}
