import pino from 'pino'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json'
const PUSHOVER_TIMEOUT_MS = 10_000

export interface PushoverOptions {
  title: string
  message: string
  /** Priority: -2 silent, -1 low, 0 normal, 1 high. Default: -1 (low — capture confirmed). */
  priority?: -2 | -1 | 0 | 1
  url?: string
  url_title?: string
}

export interface CaptureNotificationContext {
  captureId: string
  captureType: string
  brainView: string
  /** Key topics extracted from classification fields */
  topics: string
  /** Transcript snippet (first 120 chars) */
  snippet: string
}

/**
 * NotificationService sends Pushover push notifications on successful captures.
 * Silently skips if PUSHOVER_TOKEN or PUSHOVER_USER are not set — Pushover is optional.
 */
export class NotificationService {
  private token: string | undefined
  private user: string | undefined

  constructor(token?: string, user?: string) {
    this.token = token ?? process.env.PUSHOVER_TOKEN
    this.user = user ?? process.env.PUSHOVER_USER
  }

  get isConfigured(): boolean {
    return Boolean(this.token && this.user)
  }

  async send(opts: PushoverOptions): Promise<void> {
    if (!this.isConfigured) {
      logger.debug('Pushover not configured — skipping notification')
      return
    }

    const body = new URLSearchParams({
      token: this.token!,
      user: this.user!,
      title: opts.title,
      message: opts.message,
      priority: String(opts.priority ?? -1),
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.url_title ? { url_title: opts.url_title } : {}),
    })

    try {
      const res = await fetch(PUSHOVER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
      })

      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        logger.warn({ status: res.status, errorText }, 'Pushover notification failed')
        return
      }

      logger.info({ title: opts.title }, 'Pushover notification sent')
    } catch (err) {
      // Notification failures must not propagate — capture is already saved
      logger.warn({ err }, 'Pushover notification error (non-fatal)')
    }
  }

  /**
   * Convenience method: send a voice capture confirmation notification.
   * Extracts topics from classification fields and formats a user-friendly message.
   */
  async notifyCaptureSuccess(ctx: CaptureNotificationContext): Promise<void> {
    const topicsLine = ctx.topics ? `Topics: ${ctx.topics}` : ''
    const snippetLine = ctx.snippet ? `"${ctx.snippet}${ctx.snippet.length >= 120 ? '…' : ''}"` : ''

    const messageParts = [
      `Type: ${ctx.captureType}  |  View: ${ctx.brainView}`,
      snippetLine,
      topicsLine,
    ].filter(Boolean)

    await this.send({
      title: 'Voice memo captured',
      message: messageParts.join('\n'),
      priority: -1,
    })
  }
}
