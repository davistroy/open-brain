import { eq, desc, sql } from 'drizzle-orm'
import {
  email_drafts,
  captures,
  logger,
  NotFoundError,
  contentHash,
  HimalayaService,
  PushoverService,
} from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import type { ActivityFeedService } from './activity-feed.js'

// ============================================================
// Types
// ============================================================

export type EmailDraftStatus = 'draft' | 'approved' | 'sent' | 'rejected' | 'failed'
export type EmailSendMode = 'review-required' | 'auto-send'

export interface CreateEmailDraftInput {
  to: string
  subject: string
  body: string
  cc?: string
  source?: string
  sendMode?: EmailSendMode
  metadata?: Record<string, unknown>
}

export interface EmailDraftRecord {
  id: string
  to_address: string
  cc_address: string | null
  subject: string
  body: string
  status: string
  send_mode: string
  source: string | null
  approved_at: Date | null
  sent_at: Date | null
  himalaya_message_id: string | null
  capture_id: string | null
  metadata: unknown
  created_at: Date
  updated_at: Date
}

export interface EmailDraftListResult {
  items: EmailDraftRecord[]
  total: number
}

// ============================================================
// EmailDraftService
// ============================================================

/**
 * Service for managing outbound email drafts and the approve/send lifecycle.
 *
 * Lifecycle: create (draft) -> approve -> send (via HimalayaService)
 * Or: create (auto-send) -> send immediately
 * Or: create (draft) -> reject (discard)
 *
 * Sent emails are logged as captures with source='email-outbound' for
 * inclusion in the knowledge base.
 */
export class EmailDraftService {
  private himalaya: HimalayaService
  private pushover: PushoverService
  private activityFeedService?: ActivityFeedService

  constructor(
    private db: Database,
    himalaya?: HimalayaService,
    pushover?: PushoverService,
  ) {
    this.himalaya = himalaya ?? new HimalayaService()
    this.pushover = pushover ?? new PushoverService({ onError: 'swallow' })
  }

  /** Set the activity feed service (avoids circular dep in constructor) */
  setActivityFeedService(service: ActivityFeedService): void {
    this.activityFeedService = service
  }

  /**
   * Create a new email draft.
   *
   * If sendMode is 'auto-send' and Himalaya is configured, sends immediately.
   * If sendMode is 'review-required' (default), stores as draft and sends
   * a Pushover notification for manual review.
   */
  async create(input: CreateEmailDraftInput): Promise<EmailDraftRecord> {
    const sendMode = input.sendMode ?? 'review-required'

    const [row] = await this.db
      .insert(email_drafts)
      .values({
        to_address: input.to,
        cc_address: input.cc ?? null,
        subject: input.subject,
        body: input.body,
        status: 'draft',
        send_mode: sendMode,
        source: input.source ?? null,
        metadata: input.metadata ?? null,
      })
      .returning()

    logger.info(
      { draftId: row.id, to: input.to, sendMode },
      '[email-draft] draft created',
    )

    // Log to activity feed (fire-and-forget)
    this.logActivity(
      'email',
      'draft_created',
      `Email draft to ${input.to}: ${input.subject}`,
      row.id,
    )

    // For review-required drafts, send Pushover notification
    if (sendMode === 'review-required') {
      await this.notifyReviewRequired(row)
    }

    // For auto-send mode, send immediately
    if (sendMode === 'auto-send') {
      try {
        return await this.send(row.id)
      } catch (err) {
        logger.error(
          { draftId: row.id, err: err instanceof Error ? err.message : String(err) },
          '[email-draft] auto-send failed — draft saved for manual retry',
        )
        // Return the draft as-is (status remains 'draft')
        return row as EmailDraftRecord
      }
    }

    return row as EmailDraftRecord
  }

  /**
   * List email drafts with optional status filter.
   */
  async list(status?: string, limit = 50, offset = 0): Promise<EmailDraftListResult> {
    const conditions = status ? eq(email_drafts.status, status) : undefined

    const [items, countResult] = await Promise.all([
      conditions
        ? this.db
            .select()
            .from(email_drafts)
            .where(conditions)
            .orderBy(desc(email_drafts.created_at))
            .limit(limit)
            .offset(offset)
        : this.db
            .select()
            .from(email_drafts)
            .orderBy(desc(email_drafts.created_at))
            .limit(limit)
            .offset(offset),
      conditions
        ? this.db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(email_drafts)
            .where(conditions)
        : this.db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(email_drafts),
    ])

    return {
      items: items as EmailDraftRecord[],
      total: countResult[0]?.count ?? 0,
    }
  }

  /**
   * Get a single email draft by ID.
   */
  async get(id: string): Promise<EmailDraftRecord> {
    const rows = await this.db
      .select()
      .from(email_drafts)
      .where(eq(email_drafts.id, id))
      .limit(1)

    if (rows.length === 0) {
      throw new NotFoundError(`Email draft not found: ${id}`)
    }

    return rows[0] as EmailDraftRecord
  }

  /**
   * Approve a draft for sending. Sets status=approved and approved_at=now.
   */
  async approve(id: string): Promise<EmailDraftRecord> {
    const draft = await this.get(id)

    if (draft.status !== 'draft') {
      throw new Error(`Cannot approve draft in status '${draft.status}' — must be 'draft'`)
    }

    const now = new Date()
    const [updated] = await this.db
      .update(email_drafts)
      .set({
        status: 'approved',
        approved_at: now,
        updated_at: now,
      })
      .where(eq(email_drafts.id, id))
      .returning()

    logger.info({ draftId: id }, '[email-draft] draft approved')

    return updated as EmailDraftRecord
  }

  /**
   * Reject/discard a draft. Sets status=rejected.
   */
  async reject(id: string): Promise<EmailDraftRecord> {
    const draft = await this.get(id)

    if (draft.status === 'sent') {
      throw new Error(`Cannot reject a draft that has already been sent`)
    }

    const now = new Date()
    const [updated] = await this.db
      .update(email_drafts)
      .set({
        status: 'rejected',
        updated_at: now,
      })
      .where(eq(email_drafts.id, id))
      .returning()

    logger.info({ draftId: id }, '[email-draft] draft rejected')

    // Log to activity feed (fire-and-forget)
    this.logActivity(
      'email',
      'rejected',
      `Email draft rejected: ${draft.subject}`,
      id,
    )

    return updated as EmailDraftRecord
  }

  /**
   * Send a draft via Himalaya SMTP. Updates status to 'sent' on success or 'failed' on error.
   * Creates an outbound capture to log the email in the knowledge base.
   *
   * Can be called on drafts in status 'draft' or 'approved'.
   */
  async send(id: string): Promise<EmailDraftRecord> {
    const draft = await this.get(id)

    if (draft.status === 'sent') {
      throw new Error(`Draft ${id} has already been sent`)
    }
    if (draft.status === 'rejected') {
      throw new Error(`Cannot send a rejected draft`)
    }

    if (!this.himalaya.isConfigured) {
      throw new Error('HimalayaService is not configured — HIMALAYA_CONFIG not set')
    }

    // Attempt to send via Himalaya
    try {
      const result = await this.himalaya.send(
        draft.to_address,
        draft.subject,
        draft.body,
        { cc: draft.cc_address ?? undefined },
      )

      const now = new Date()
      const [updated] = await this.db
        .update(email_drafts)
        .set({
          status: 'sent',
          sent_at: now,
          himalaya_message_id: result.output || null,
          updated_at: now,
        })
        .where(eq(email_drafts.id, id))
        .returning()

      logger.info(
        { draftId: id, to: draft.to_address, subject: draft.subject },
        '[email-draft] email sent successfully',
      )

      // Log to activity feed (fire-and-forget)
      this.logActivity(
        'email',
        'sent',
        `Email sent to ${draft.to_address}: ${draft.subject}`,
        id,
      )

      // Create outbound capture (fire-and-forget)
      this.createOutboundCapture(updated as EmailDraftRecord).catch((err) => {
        logger.warn(
          { draftId: id, err: err instanceof Error ? err.message : String(err) },
          '[email-draft] failed to create outbound capture',
        )
      })

      return updated as EmailDraftRecord
    } catch (err) {
      // Mark as failed
      const now = new Date()
      await this.db
        .update(email_drafts)
        .set({
          status: 'failed',
          updated_at: now,
          metadata: { ...(draft.metadata as Record<string, unknown> || {}), last_error: err instanceof Error ? err.message : String(err) },
        })
        .where(eq(email_drafts.id, id))

      logger.error(
        { draftId: id, err: err instanceof Error ? err.message : String(err) },
        '[email-draft] send failed',
      )

      throw err
    }
  }

  /**
   * Approve and immediately send a draft in one operation.
   */
  async approveThenSend(id: string): Promise<EmailDraftRecord> {
    await this.approve(id)
    return this.send(id)
  }

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Create a capture record for the sent email, so outbound emails
   * are part of the knowledge base.
   */
  private async createOutboundCapture(draft: EmailDraftRecord): Promise<void> {
    const content = [
      `[Email sent to ${draft.to_address}]`,
      `Subject: ${draft.subject}`,
      '',
      draft.body,
    ].join('\n')

    const hash = contentHash(content)

    const [capture] = await this.db
      .insert(captures)
      .values({
        content,
        content_hash: hash,
        capture_type: 'observation',
        brain_view: 'personal',
        source: 'email-outbound',
        source_metadata: {
          to: draft.to_address,
          cc: draft.cc_address,
          subject: draft.subject,
          draft_id: draft.id,
        },
        tags: ['email', 'outbound'],
        pipeline_status: 'pending',
      })
      .returning()

    // Link the capture back to the draft
    await this.db
      .update(email_drafts)
      .set({ capture_id: capture.id, updated_at: new Date() })
      .where(eq(email_drafts.id, draft.id))

    logger.info(
      { draftId: draft.id, captureId: capture.id },
      '[email-draft] outbound capture created',
    )
  }

  /**
   * Log an email event to the activity feed (fire-and-forget).
   */
  private logActivity(type: string, subtype: string, summary: string, sourceId?: string): void {
    if (!this.activityFeedService) return
    this.activityFeedService.insert({
      type,
      subtype,
      summary,
      source_id: sourceId,
    }).catch((err) => {
      logger.debug({ err }, '[email-draft] activity feed insert failed')
    })
  }

  /**
   * Send a Pushover notification for drafts that require review.
   */
  private async notifyReviewRequired(draft: EmailDraftRecord): Promise<void> {
    if (!this.pushover.isConfigured) return

    try {
      await this.pushover.send({
        title: 'Email Draft for Review',
        message: `To: ${draft.to_address}\nSubject: ${draft.subject}\n\nReview and approve at brain.troy-davis.com`,
        priority: 0,
        url: 'https://brain.troy-davis.com',
        url_title: 'Open Brain Dashboard',
      })
      logger.info({ draftId: draft.id }, '[email-draft] review notification sent')
    } catch {
      logger.warn({ draftId: draft.id }, '[email-draft] review notification failed')
    }
  }
}
