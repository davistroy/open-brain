import nodemailer from 'nodemailer'
import { logger } from '../lib/logger.js'

export interface EmailSendOptions {
  to: string
  subject: string
  htmlBody: string
  /** Plain text fallback — required; shown when HTML is unavailable */
  textBody: string
}

/**
 * EmailService — SMTP email delivery for reports and digests.
 *
 * Credentials: SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
 * SMTP_FROM (default "Open Brain <no-reply@open-brain>") from environment.
 *
 * Silently skips if SMTP_HOST or SMTP_USER is not configured — useful in
 * dev environments where email isn't wired up.
 *
 * Throws on transport or delivery error so the BullMQ job handler can retry
 * on transient SMTP failures.
 */
export class EmailService {
  private host: string | undefined
  private port: number
  private user: string | undefined
  private pass: string | undefined
  private from: string

  constructor(opts?: {
    host?: string
    port?: number
    user?: string
    pass?: string
    from?: string
  }) {
    this.host = opts?.host ?? process.env.SMTP_HOST
    this.port = opts?.port ?? parseInt(process.env.SMTP_PORT ?? '587', 10)
    this.user = opts?.user ?? process.env.SMTP_USER
    this.pass = opts?.pass ?? process.env.SMTP_PASS
    this.from = opts?.from ?? process.env.SMTP_FROM ?? 'Open Brain <no-reply@open-brain>'
  }

  get isConfigured(): boolean {
    return Boolean(this.host && this.user)
  }

  /**
   * Send an HTML email with a plain text fallback.
   *
   * Throws on SMTP connection or delivery error. The BullMQ job handler
   * retries on transient failures (3 attempts, 30s fixed backoff).
   *
   * Silently returns if SMTP credentials are not configured.
   */
  async send(opts: EmailSendOptions): Promise<void> {
    if (!this.isConfigured) {
      logger.debug('[email] SMTP not configured — skipping email delivery')
      return
    }

    const transporter = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.port === 465,
      auth: {
        user: this.user,
        pass: this.pass,
      },
    })

    logger.debug({ to: opts.to, subject: opts.subject }, '[email] sending email')

    await transporter.sendMail({
      from: this.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.htmlBody,
      text: opts.textBody,
    })

    logger.info({ to: opts.to, subject: opts.subject }, '[email] email sent successfully')
  }
}
