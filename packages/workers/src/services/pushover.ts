import { logger } from '../lib/logger.js'

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json'
const PUSHOVER_TIMEOUT_MS = 10_000

/**
 * Priority levels per Pushover API:
 * -1 — low/quiet (capture confirmed; no sound if device in quiet hours)
 *  0 — normal (brief ready, info alerts)
 *  1 — high (bet expiring, pipeline failure; always sounds)
 *  2 — emergency (system health critical; repeats every `retry` seconds until `expire` or acknowledged)
 */
export type PushoverPriority = -1 | 0 | 1 | 2

export interface PushoverSendOptions {
  title: string
  message: string
  priority?: PushoverPriority
  url?: string
  url_title?: string
  /**
   * Emergency priority (2) only — how often (seconds) to repeat the alert.
   * Minimum 30. Defaults to 60 if not specified.
   */
  retry?: number
  /**
   * Emergency priority (2) only — how long (seconds) to keep retrying.
   * Maximum 10800 (3 hours). Defaults to 3600 if not specified.
   */
  expire?: number
}

/**
 * PushoverService — sends push notifications to iPhone via Pushover HTTP API.
 *
 * Credentials: PUSHOVER_APP_TOKEN + PUSHOVER_USER_KEY from environment.
 * Silently skips if either credential is missing — Pushover is optional for
 * dev environments.
 *
 * Emergency priority (2) requires `retry` and `expire` params per Pushover
 * API requirements. Defaults to retry=60, expire=3600 if not provided.
 *
 * Unlike the voice-capture NotificationService (which swallows all errors),
 * this service throws on HTTP errors so the BullMQ job handler can retry
 * on transient Pushover API failures.
 */
export class PushoverService {
  private appToken: string | undefined
  private userKey: string | undefined

  constructor(appToken?: string, userKey?: string) {
    this.appToken = appToken ?? process.env.PUSHOVER_APP_TOKEN
    this.userKey = userKey ?? process.env.PUSHOVER_USER_KEY
  }

  get isConfigured(): boolean {
    return Boolean(this.appToken && this.userKey)
  }

  /**
   * Send a Pushover notification.
   *
   * Throws on HTTP error (non-2xx response) so BullMQ job retries on transient
   * Pushover API failures. Throws on network timeout.
   *
   * Silently returns if Pushover credentials are not configured.
   */
  async send(opts: PushoverSendOptions): Promise<void> {
    if (!this.isConfigured) {
      logger.debug('[pushover] credentials not configured — skipping notification')
      return
    }

    const priority = opts.priority ?? -1

    const params: Record<string, string> = {
      token: this.appToken!,
      user: this.userKey!,
      title: opts.title,
      message: opts.message,
      priority: String(priority),
    }

    if (opts.url) params.url = opts.url
    if (opts.url_title) params.url_title = opts.url_title

    // Emergency priority requires retry + expire per Pushover API
    if (priority === 2) {
      params.retry = String(opts.retry ?? 60)
      params.expire = String(opts.expire ?? 3600)
    }

    const body = new URLSearchParams(params)

    logger.debug({ title: opts.title, priority }, '[pushover] sending notification')

    const res = await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      const msg = `[pushover] API error ${res.status}: ${errorText}`
      logger.warn({ status: res.status, title: opts.title }, msg)
      throw new Error(msg)
    }

    logger.info({ title: opts.title, priority }, '[pushover] notification sent')
  }
}
