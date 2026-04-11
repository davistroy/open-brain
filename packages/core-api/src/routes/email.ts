import type { Hono } from 'hono'
import { logger } from '@open-brain/shared'
import type { EmailDraftService } from '../services/email-draft.js'

const VALID_STATUSES = ['draft', 'approved', 'sent', 'rejected', 'failed'] as const
const VALID_SEND_MODES = ['review-required', 'auto-send'] as const

/**
 * Register email draft management API routes.
 *
 * GET    /api/v1/email/drafts         — list drafts (optional ?status= filter, ?limit=, ?offset=)
 * GET    /api/v1/email/drafts/:id     — get a single draft
 * POST   /api/v1/email/drafts         — create a new draft
 * POST   /api/v1/email/drafts/:id/send — approve and send a draft
 * DELETE /api/v1/email/drafts/:id     — reject/discard a draft
 */
export function registerEmailRoutes(
  app: Hono,
  emailDraftService: EmailDraftService,
): void {
  // -----------------------------------------------------------------------
  // GET /api/v1/email/drafts
  // Query: ?status=draft|approved|sent|rejected|failed, ?limit=50, ?offset=0
  // -----------------------------------------------------------------------
  app.get('/api/v1/email/drafts', async (c) => {
    const status = c.req.query('status')
    const limitRaw = c.req.query('limit')
    const offsetRaw = c.req.query('offset')

    if (status && !VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
      return c.json(
        { error: `Invalid status filter: ${status}. Valid values: ${VALID_STATUSES.join(', ')}`, code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Number(limitRaw), 100) : 50
    const offset = Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : 0

    const result = await emailDraftService.list(status, limit, offset)

    return c.json({
      items: result.items,
      total: result.total,
      limit,
      offset,
    })
  })

  // -----------------------------------------------------------------------
  // GET /api/v1/email/drafts/:id
  // -----------------------------------------------------------------------
  app.get('/api/v1/email/drafts/:id', async (c) => {
    const id = c.req.param('id')
    const draft = await emailDraftService.get(id)
    return c.json(draft)
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/email/drafts
  // Body: { to, subject, body, cc?, source?, sendMode?, metadata? }
  // -----------------------------------------------------------------------
  app.post('/api/v1/email/drafts', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'VALIDATION_ERROR' }, 400)
    }

    // Required fields
    const to = body.to
    const subject = body.subject
    const emailBody = body.body

    if (typeof to !== 'string' || !to.trim()) {
      return c.json({ error: 'Missing or invalid "to" field', code: 'VALIDATION_ERROR' }, 400)
    }
    if (typeof subject !== 'string' || !subject.trim()) {
      return c.json({ error: 'Missing or invalid "subject" field', code: 'VALIDATION_ERROR' }, 400)
    }
    if (typeof emailBody !== 'string' || !emailBody.trim()) {
      return c.json({ error: 'Missing or invalid "body" field', code: 'VALIDATION_ERROR' }, 400)
    }

    // Optional fields
    const sendMode = body.sendMode ?? body.send_mode
    if (sendMode !== undefined && !VALID_SEND_MODES.includes(sendMode as (typeof VALID_SEND_MODES)[number])) {
      return c.json(
        { error: `Invalid sendMode: ${sendMode}. Valid values: ${VALID_SEND_MODES.join(', ')}`, code: 'VALIDATION_ERROR' },
        400,
      )
    }

    const draft = await emailDraftService.create({
      to: to.trim(),
      subject: subject.trim(),
      body: emailBody.trim(),
      cc: typeof body.cc === 'string' ? body.cc.trim() : undefined,
      source: typeof body.source === 'string' ? body.source.trim() : undefined,
      sendMode: sendMode as 'review-required' | 'auto-send' | undefined,
      metadata: typeof body.metadata === 'object' && body.metadata !== null
        ? body.metadata as Record<string, unknown>
        : undefined,
    })

    logger.info({ draftId: draft.id, to: draft.to_address }, '[email-routes] draft created')

    return c.json(
      {
        id: draft.id,
        status: draft.status,
        send_mode: draft.send_mode,
        created_at: draft.created_at,
      },
      201,
    )
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/email/drafts/:id/send — approve and send
  // -----------------------------------------------------------------------
  app.post('/api/v1/email/drafts/:id/send', async (c) => {
    const id = c.req.param('id')

    const draft = await emailDraftService.approveThenSend(id)

    logger.info({ draftId: id, to: draft.to_address }, '[email-routes] draft approved and sent')

    return c.json({
      id: draft.id,
      status: draft.status,
      sent_at: draft.sent_at,
    })
  })

  // -----------------------------------------------------------------------
  // DELETE /api/v1/email/drafts/:id — reject/discard
  // -----------------------------------------------------------------------
  app.delete('/api/v1/email/drafts/:id', async (c) => {
    const id = c.req.param('id')

    const draft = await emailDraftService.reject(id)

    logger.info({ draftId: id }, '[email-routes] draft rejected')

    return c.json({
      id: draft.id,
      status: draft.status,
    })
  })
}
