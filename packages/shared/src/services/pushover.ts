import { createLogger } from '../lib/logger.js'

const logger = createLogger('pushover')

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json'
const PUSHOVER_TIMEOUT_MS = 10_000

/**
 * Priority levels per Pushover API:
 * -2 — silent (no sound, no vibration)
 * -1 — low/quiet (capture confirmed; no sound if device in quiet hours)
 *  0 — normal (brief ready, info alerts)
 *  1 — high (bet expiring, pipeline failure; always sounds)
 *  2 — emergency (system health critical; repeats every `retry` seconds until acknowledged)
 */
export type PushoverPriority = -2 | -1 | 0 | 1 | 2

export interface PushoverSendOptions {
  title: string
  message: string
  priority?: PushoverPriority
  url?: string
  url_title?: string
  /** Emergency priority (2) only — retry interval in seconds. Min 30, default 60. */
  retry?: number
  /** Emergency priority (2) only — how long to retry in seconds. Max 10800, default 3600. */
  expire?: number
}

export interface PushoverConfig {
  appToken?: string
  userKey?: string
  /** 'throw' = propagate errors (for BullMQ retry); 'swallow' = log and return (for non-critical notifications) */
  onError?: 'throw' | 'swallow'
  /**
   * Identity prefixed to every notification title so an alert is unmistakable
   * regardless of the Pushover *application* name shown in the banner — that
   * name ("From Voice Capture") is registered in the Pushover console and cannot
   * be set per message (#312). Idempotent: a title already starting with the
   * prefix (case-insensitive) is left unchanged. Resolution order:
   * this option → `PUSHOVER_TITLE_PREFIX` env → `'Open Brain'` default.
   * Pass an empty string to disable prefixing.
   */
  titlePrefix?: string
}

const DEFAULT_TITLE_PREFIX = 'Open Brain'

/**
 * Sends push notifications via the Pushover HTTP API.
 *
 * Supports two error-handling modes:
 * - `onError: 'throw'` (default) — propagates HTTP and network errors (for BullMQ retry)
 * - `onError: 'swallow'` — logs warning and returns silently (for non-critical notifications)
 *
 * Silently returns if credentials are not configured.
 */
export class PushoverService {
  private appToken: string | undefined
  private userKey: string | undefined
  private errorMode: 'throw' | 'swallow'
  private titlePrefix: string

  /**
   * Supports two call forms for backward compatibility:
   * - `new PushoverService({ appToken, userKey, onError })` — config object (preferred)
   * - `new PushoverService(appToken?, userKey?)` — legacy positional args
   */
  constructor(configOrAppToken?: PushoverConfig | string, legacyUserKey?: string) {
    if (typeof configOrAppToken === 'string' || (configOrAppToken === undefined && legacyUserKey !== undefined)) {
      // Legacy positional-args form: PushoverService(appToken?, userKey?)
      this.appToken = configOrAppToken ?? process.env.PUSHOVER_APP_TOKEN
      this.userKey = legacyUserKey ?? process.env.PUSHOVER_USER_KEY
      this.errorMode = 'throw'
      this.titlePrefix = process.env.PUSHOVER_TITLE_PREFIX ?? DEFAULT_TITLE_PREFIX
    } else {
      // Config-object form
      const config = configOrAppToken
      this.appToken = config?.appToken ?? process.env.PUSHOVER_APP_TOKEN
      this.userKey = config?.userKey ?? process.env.PUSHOVER_USER_KEY
      this.errorMode = config?.onError ?? 'throw'
      this.titlePrefix = config?.titlePrefix ?? process.env.PUSHOVER_TITLE_PREFIX ?? DEFAULT_TITLE_PREFIX
    }
  }

  /**
   * Prepend the app-identity prefix to a title, idempotently. A title already
   * starting with the prefix (case-insensitive) — e.g. "Open Brain: Backup
   * Stale" or the bare "Open Brain" — is returned unchanged. An empty prefix
   * disables the behavior entirely.
   */
  private withIdentity(title: string): string {
    const prefix = this.titlePrefix
    if (!prefix) return title
    if (title.toLowerCase().startsWith(prefix.toLowerCase())) return title
    return `${prefix}: ${title}`
  }

  get isConfigured(): boolean {
    return Boolean(this.appToken && this.userKey)
  }

  async send(opts: PushoverSendOptions): Promise<void> {
    if (!this.isConfigured) {
      logger.debug('credentials not configured — skipping notification')
      return
    }

    const priority = opts.priority ?? -1

    const params: Record<string, string> = {
      token: this.appToken!,
      user: this.userKey!,
      title: this.withIdentity(opts.title),
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

    try {
      logger.debug({ title: opts.title, priority }, 'sending notification')

      const res = await fetch(PUSHOVER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
      })

      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        const msg = `Pushover API error ${res.status}: ${errorText}`
        logger.warn({ status: res.status, title: opts.title }, msg)
        if (this.errorMode === 'throw') throw new Error(msg)
        return
      }

      logger.info({ title: opts.title, priority }, 'notification sent')
    } catch (err) {
      if (this.errorMode === 'throw') throw err
      logger.warn({ err }, 'notification error (non-fatal)')
    }
  }
}
