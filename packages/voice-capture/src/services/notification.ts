import { PushoverService } from '@open-brain/shared'
import type { PushoverSendOptions } from '@open-brain/shared'

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
 * Voice-capture-specific Pushover options (subset — no emergency priority needed here).
 */
export interface PushoverOptions {
  title: string
  message: string
  priority?: -2 | -1 | 0 | 1
  url?: string
  url_title?: string
}

/**
 * NotificationService wraps shared PushoverService with voice-capture-specific
 * convenience methods. Uses `onError: 'swallow'` so notification failures never
 * propagate — captures are already saved by the time we notify.
 *
 * Constructor accepts optional token/user for backward compatibility with tests.
 */
export class NotificationService {
  private pushover: PushoverService

  constructor(token?: string, user?: string) {
    this.pushover = new PushoverService({
      // SW5-L5: prefer the canonical PUSHOVER_APP_TOKEN/USER_KEY (used by the
      // rest of the stack); fall back to the legacy PUSHOVER_TOKEN/USER for one
      // release so an unmigrated .env.secrets keeps working.
      appToken: token ?? process.env.PUSHOVER_APP_TOKEN ?? process.env.PUSHOVER_TOKEN,
      userKey: user ?? process.env.PUSHOVER_USER_KEY ?? process.env.PUSHOVER_USER,
      onError: 'swallow',
    })
  }

  get isConfigured(): boolean {
    return this.pushover.isConfigured
  }

  async send(opts: PushoverOptions): Promise<void> {
    await this.pushover.send(opts as PushoverSendOptions)
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

    await this.pushover.send({
      title: 'Voice memo captured',
      message: messageParts.join('\n'),
      priority: -1,
    })
  }
}
