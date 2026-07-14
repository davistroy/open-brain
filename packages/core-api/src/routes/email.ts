import type { Hono } from 'hono'
import { z } from 'zod'
import { ServiceUnavailableError, ValidationError, logger } from '@open-brain/shared'
import type { EmailDraftService } from '../services/email-draft.js'
import type { EmailComposeAssistService } from '../services/email-compose-assist.js'
import { parseUUIDParam } from '../lib/validation.js'

const VALID_STATUSES = ['draft', 'approved', 'sent', 'rejected', 'failed'] as const
const VALID_SEND_MODES = ['review-required', 'auto-send'] as const

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const patchDraftSchema = z
  .object({
    to: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  })
  .refine(
    (v) =>
      v.to !== undefined ||
      v.cc !== undefined ||
      v.subject !== undefined ||
      v.body !== undefined,
    { message: 'At least one of to, cc, subject, body must be provided' },
  )

const composeDraftSchema = z.object({
  instruction: z.string().min(1, 'instruction is required'),
  existing_draft: z
    .object({
      to: z.array(z.string()).optional(),
      cc: z.array(z.string()).optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
    })
    .optional(),
})

/**
 * Register email draft management API routes.
 *
 * GET    /api/v1/email/drafts         — list drafts (optional ?status= filter, ?limit=, ?offset=)
 * GET    /api/v1/email/drafts/:id     — get a single draft
 * POST   /api/v1/email/drafts         — create a new draft
 * PATCH  /api/v1/email/drafts/:id     — partially update an existing draft (status='draft' only)
 * POST   /api/v1/email/drafts/:id/send — approve and send a draft
 * DELETE /api/v1/email/drafts/:id     — reject/discard a draft
 * POST   /api/v1/email/compose-draft  — AI-assist: generate a proposed draft (not persisted)
 */
export function registerEmailRoutes(
  app: Hono,
  emailDraftService: EmailDraftService,
  emailComposeAssistService?: EmailComposeAssistService,
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
    const id = parseUUIDParam(c.req.param('id'))
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
      throw new ValidationError('Invalid JSON body')
    }

    // Required fields
    const to = body.to
    const subject = body.subject
    const emailBody = body.body

    if (typeof to !== 'string' || !to.trim()) {
      throw new ValidationError('Missing or invalid "to" field')
    }
    if (typeof subject !== 'string' || !subject.trim()) {
      throw new ValidationError('Missing or invalid "subject" field')
    }
    if (typeof emailBody !== 'string' || !emailBody.trim()) {
      throw new ValidationError('Missing or invalid "body" field')
    }

    // Optional fields
    const sendMode = body.sendMode ?? body.send_mode
    if (sendMode !== undefined && !VALID_SEND_MODES.includes(sendMode as (typeof VALID_SEND_MODES)[number])) {
      throw new ValidationError(
        `Invalid sendMode: ${sendMode}. Valid values: ${VALID_SEND_MODES.join(', ')}`,
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
  // PATCH /api/v1/email/drafts/:id — partial update of a draft-status draft
  // Body: { to?: string[]; cc?: string[]; subject?: string; body?: string }
  //
  // Notes:
  //  - EmailDraftService stores to/cc as comma-joined strings; arrays coming
  //    from the web client are joined with ', ' here before hitting the
  //    service layer to keep the storage shape consistent.
  //  - 409 CONFLICT if the draft is not in status='draft' (already sent,
  //    approved, failed, or rejected).
  // -----------------------------------------------------------------------
  app.patch('/api/v1/email/drafts/:id', async (c) => {
    const id = parseUUIDParam(c.req.param('id'))

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      throw new ValidationError('Invalid JSON body')
    }

    const parsed = patchDraftSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => i.message).join('; ') || 'Invalid body',
      )
    }

    const patch = parsed.data

    const draft = await emailDraftService.update(id, {
      to: patch.to !== undefined ? patch.to.join(', ') : undefined,
      cc: patch.cc !== undefined
        ? (patch.cc.length > 0 ? patch.cc.join(', ') : null)
        : undefined,
      subject: patch.subject,
      body: patch.body,
    })

    logger.info(
      { draftId: id, fields: Object.keys(patch) },
      '[email-routes] draft patched',
    )

    return c.json(draft)
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/email/drafts/:id/send — approve and send
  // -----------------------------------------------------------------------
  app.post('/api/v1/email/drafts/:id/send', async (c) => {
    const id = parseUUIDParam(c.req.param('id'))

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
    const id = parseUUIDParam(c.req.param('id'))

    const draft = await emailDraftService.reject(id)

    logger.info({ draftId: id }, '[email-routes] draft rejected')

    return c.json({
      id: draft.id,
      status: draft.status,
    })
  })

  // -----------------------------------------------------------------------
  // POST /api/v1/email/compose-draft — synchronous AI-assist
  // Body: { instruction: string, existing_draft?: { to?, cc?, subject?, body? } }
  // Returns: { body, subject?, to?, cc? }
  //
  // Invokes the shared runAgent() tool-use loop against the brain DB
  // (search_brain / get_entity) to produce a context-aware proposed draft.
  // The result is NOT persisted — the web drawer saves via POST/PATCH
  // /email/drafts when the user chooses to.
  // -----------------------------------------------------------------------
  app.post('/api/v1/email/compose-draft', async (c) => {
    if (!emailComposeAssistService) {
      throw new ServiceUnavailableError(
        'AI compose is unavailable — compose service is not configured',
      )
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      throw new ValidationError('Invalid JSON body')
    }

    const parsed = composeDraftSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => i.message).join('; ') || 'Invalid body',
      )
    }

    try {
      const result = await emailComposeAssistService.compose({
        instruction: parsed.data.instruction,
        existingDraft: parsed.data.existing_draft,
      })

      return c.json(result)
    } catch (err) {
      // ServiceUnavailableError and other AppError subclasses propagate to
      // the global onError handler (returns their statusCode). Unknown
      // errors from the agent loop get a generic 500 with a safe message.
      const message = err instanceof Error ? err.message : 'AI compose failed'
      logger.warn(
        { err: message },
        '[email-routes] compose-draft failed',
      )
      // Re-throw AppErrors so the global handler maps them correctly.
      if (err && typeof err === 'object' && 'statusCode' in err) {
        throw err
      }
      return c.json(
        { error: message, code: 'COMPOSE_FAILED' },
        500,
      )
    }
  })
}
