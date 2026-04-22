import type { Hono } from 'hono'
import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { commitments } from '@open-brain/shared'
import { CommitmentStatusSchema } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

/**
 * Register commitments API routes.
 *
 * GET  /api/v1/commitments                  — list all commitments (status, entity_id filters; sorted by due_date ASC)
 * GET  /api/v1/entities/:id/commitments     — entity-scoped list (open/non-resolved by default)
 * PATCH /api/v1/commitments/:id             — toggle resolved (sets/clears resolved_at)
 * POST  /api/v1/commitments                 — manual creation
 *
 * Default rate-limit tier applies; web-ui is already in BYPASS_CALLERS.
 */
export function registerCommitmentRoutes(app: Hono, db: Database): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/commitments
  // List commitments with optional filters + pagination.
  // Query params:
  //   status       — filter by CommitmentStatus (pending|owed_by_user|waiting_on|resolved)
  //   entity_id    — filter by entity UUID
  //   limit        — default 50, max 200
  //   offset       — default 0
  // Returns: { commitments: Commitment[], total: number, limit: number, offset: number }
  // -------------------------------------------------------------------------
  app.get('/api/v1/commitments', async (c) => {
    const rawStatus = c.req.query('status')
    const rawEntityId = c.req.query('entity_id')
    const rawLimit = c.req.query('limit')
    const rawOffset = c.req.query('offset')

    // Validate status if provided
    if (rawStatus) {
      const parsed = CommitmentStatusSchema.safeParse(rawStatus)
      if (!parsed.success) {
        return c.json(
          { error: `Invalid status. Valid values: pending, owed_by_user, waiting_on, resolved`, code: 'VALIDATION_ERROR' },
          400,
        )
      }
    }

    const limit = Math.min(Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : 50, 200)
    const offset = Number.isFinite(Number(rawOffset)) ? Number(rawOffset) : 0

    // Build WHERE conditions
    const conditions = []
    if (rawStatus) {
      conditions.push(eq(commitments.status, rawStatus))
    }
    if (rawEntityId) {
      conditions.push(eq(commitments.entity_id, rawEntityId))
    }

    const rows = conditions.length > 0
      ? await db.select().from(commitments).where(and(...conditions)).orderBy(asc(commitments.due_date)).limit(limit).offset(offset)
      : await db.select().from(commitments).orderBy(asc(commitments.due_date)).limit(limit).offset(offset)

    // Count query for total
    const countConditions = [...conditions]
    const allRows = countConditions.length > 0
      ? await db.select({ id: commitments.id }).from(commitments).where(and(...countConditions))
      : await db.select({ id: commitments.id }).from(commitments)

    return c.json({
      items: rows,
      total: allRows.length,
      limit,
      offset,
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/entities/:id/commitments
  // Entity-scoped commitment list. Returns open (non-resolved) by default.
  // Query params:
  //   include_resolved — boolean (default false); set to "true" to include resolved rows
  //   limit            — default 50, max 200
  //   offset           — default 0
  // Returns: { commitments: Commitment[], total: number, limit: number, offset: number }
  // -------------------------------------------------------------------------
  app.get('/api/v1/entities/:id/commitments', async (c) => {
    const entityId = c.req.param('id')
    const rawIncludeResolved = c.req.query('include_resolved')
    const rawLimit = c.req.query('limit')
    const rawOffset = c.req.query('offset')

    const includeResolved = rawIncludeResolved === 'true'
    const limit = Math.min(Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : 50, 200)
    const offset = Number.isFinite(Number(rawOffset)) ? Number(rawOffset) : 0

    // Always filter by entity_id; optionally exclude resolved
    const conditions = [eq(commitments.entity_id, entityId)]
    if (!includeResolved) {
      conditions.push(ne(commitments.status, 'resolved'))
    }

    const rows = await db
      .select()
      .from(commitments)
      .where(and(...conditions))
      .orderBy(asc(commitments.due_date))
      .limit(limit)
      .offset(offset)

    const countRows = await db
      .select({ id: commitments.id })
      .from(commitments)
      .where(and(...conditions))

    return c.json({
      items: rows,
      total: countRows.length,
      limit,
      offset,
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /api/v1/commitments/:id
  // Toggle resolved state.
  //   resolved: true  → sets status='resolved', resolved_at=NOW()
  //   resolved: false → sets status='pending',  resolved_at=NULL
  // Body: { resolved: boolean }
  // Returns: { commitment } (updated row)
  // -------------------------------------------------------------------------
  app.patch('/api/v1/commitments/:id', async (c) => {
    const id = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { resolved } = body as { resolved?: unknown }

    if (typeof resolved !== 'boolean') {
      return c.json({ error: '`resolved` (boolean) is required', code: 'VALIDATION_ERROR' }, 400)
    }

    // Verify commitment exists
    const existing = await db.select().from(commitments).where(eq(commitments.id, id)).limit(1)
    if (existing.length === 0) {
      return c.json({ error: `Commitment not found: ${id}`, code: 'NOT_FOUND' }, 404)
    }

    const updated = await db
      .update(commitments)
      .set({
        status: resolved ? 'resolved' : 'pending',
        resolved_at: resolved ? new Date() : null,
      })
      .where(eq(commitments.id, id))
      .returning()

    logger.info({ id, resolved }, '[commitments-api] commitment toggled')

    return c.json({ commitment: updated[0] })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/commitments
  // Manually create a commitment.
  // Body: { text: string, capture_id: string, entity_id?: string, due_date?: string, status?: CommitmentStatus }
  // Returns: { commitment } with 201 Created
  // -------------------------------------------------------------------------
  app.post('/api/v1/commitments', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    const { text, capture_id, entity_id, due_date, status } = body as {
      text?: unknown
      capture_id?: unknown
      entity_id?: unknown
      due_date?: unknown
      status?: unknown
    }

    // Required fields
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return c.json({ error: '`text` is required', code: 'VALIDATION_ERROR' }, 400)
    }
    if (!capture_id || typeof capture_id !== 'string' || capture_id.trim().length === 0) {
      return c.json({ error: '`capture_id` is required', code: 'VALIDATION_ERROR' }, 400)
    }

    // Optional status — default 'pending', validate if provided
    let resolvedStatus: string = 'pending'
    if (status !== undefined) {
      const parsed = CommitmentStatusSchema.safeParse(status)
      if (!parsed.success) {
        return c.json(
          { error: `Invalid status. Valid values: pending, owed_by_user, waiting_on, resolved`, code: 'VALIDATION_ERROR' },
          400,
        )
      }
      resolvedStatus = parsed.data
    }

    // Optional due_date — basic YYYY-MM-DD format check
    if (due_date !== undefined && typeof due_date !== 'string') {
      return c.json({ error: '`due_date` must be a string (YYYY-MM-DD)', code: 'VALIDATION_ERROR' }, 400)
    }

    const newRow = await db
      .insert(commitments)
      .values({
        text: (text as string).trim(),
        capture_id: (capture_id as string).trim(),
        entity_id: entity_id ? (entity_id as string).trim() : null,
        due_date: due_date ? (due_date as string) : null,
        status: resolvedStatus,
        resolved_at: resolvedStatus === 'resolved' ? new Date() : null,
      })
      .returning()

    logger.info({ id: newRow[0].id, capture_id, status: resolvedStatus }, '[commitments-api] commitment created')

    return c.json({ commitment: newRow[0] }, 201)
  })
}
