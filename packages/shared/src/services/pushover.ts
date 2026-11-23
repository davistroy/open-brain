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

/** Pushover API limits: message 1,024 characters, title 250 characters. */
export const PUSHOVER_MAX_MESSAGE_CHARS = 1024
export const PUSHOVER_MAX_TITLE_CHARS = 250

/** Result of an emergency-priority (2) send: the receipt used to poll acknowledgement. */
export interface PushoverSendResult {
  receipt: string
}

/** Result of `getReceipt()`. `acknowledgedAt` is an ISO timestamp or null. */
export interface PushoverReceiptStatus {
  acknowledged: boolean
  acknowledgedAt: string | null
  expired: boolean
}

/**
 * Cap `text` at `max` characters. A truncated value ends with `…(+N)`, N being
 * the number of removed characters, and the whole result is exactly `max` long.
 * Counts code points so a surrogate pair is never split.
 */
export function truncateWithCount(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  // The suffix length depends on the digits of N, which depends on the kept length: iterate to a fixed point.
  let keep = max
  for (let i = 0; i < 6; i++) {
    const suffix = `…(+${chars.length - keep})`
    const next = Math.max(0, max - Array.from(suffix).length)
    if (next === keep) break
    keep = next
  }
  const suffix = `…(+${chars.length - keep})`
  return chars.slice(0, keep).join('') + suffix
}

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

  /**
   * Send a notification. Messages over 1,024 characters and titles over 250 are
   * truncated with a `…(+N)` suffix (Pushover rejects them otherwise). Returns
   * `{ receipt }` for priority 2 (when Pushover supplies one); `undefined` otherwise.
   */
  async send(opts: PushoverSendOptions): Promise<PushoverSendResult | undefined> {
    if (!this.isConfigured) {
      logger.debug('credentials not configured — skipping notification')
      return undefined
    }

    const priority = opts.priority ?? -1

    const params: Record<string, string> = {
      token: this.appToken!,
      user: this.userKey!,
      title: truncateWithCount(this.withIdentity(opts.title), PUSHOVER_MAX_TITLE_CHARS),
      message: truncateWithCount(opts.message, PUSHOVER_MAX_MESSAGE_CHARS),
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
        return undefined
      }

      logger.info({ title: opts.title, priority }, 'notification sent')

      if (priority !== 2) return undefined
      try {
        const json = (await res.json()) as { receipt?: unknown }
        return typeof json.receipt === 'string' && json.receipt ? { receipt: json.receipt } : undefined
      } catch {
        logger.warn({ title: opts.title }, 'priority-2 notification sent but response had no parseable receipt')
        return undefined
      }
    } catch (err) {
      if (this.errorMode === 'throw') throw err
      logger.warn({ err }, 'notification error (non-fatal)')
      return undefined
    }
  }

  /**
   * Look up the acknowledgement state of a priority-2 receipt. Returns null when
   * credentials are not configured. Throws on HTTP/network failure regardless of
   * `onError` — the caller decides whether a failed lookup matters.
   */
  async getReceipt(receipt: string): Promise<PushoverReceiptStatus | null> {
    if (!this.isConfigured) return null
    const url = `https://api.pushover.net/1/receipts/${encodeURIComponent(receipt)}.json?token=${encodeURIComponent(this.appToken!)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`Pushover receipt API error ${res.status}`)
    }
    const json = (await res.json()) as {
      acknowledged?: number
      acknowledged_at?: number
      expired?: number
    }
    const acknowledged = json.acknowledged === 1
    const at = json.acknowledged_at
    return {
      acknowledged,
      acknowledgedAt: acknowledged && typeof at === 'number' && at > 0 ? new Date(at * 1000).toISOString() : null,
      expired: json.expired === 1,
    }
  }
}
