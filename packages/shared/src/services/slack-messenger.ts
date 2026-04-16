import { createLogger } from '../lib/logger.js'

const logger = createLogger('slack-messenger')

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage'
const SLACK_TIMEOUT_MS = 10_000

/**
 * Slack Block Kit block types used by SlackMessenger.
 * Subset of the full Block Kit spec — only what we actually use.
 */
export interface SlackBlock {
  type: string
  text?: { type: string; text: string; emoji?: boolean }
  fields?: Array<{ type: string; text: string }>
  elements?: Array<{ type: string; text: string }>
  block_id?: string
}

export interface SlackSendOptions {
  channel: string
  text: string
  blocks?: SlackBlock[]
}

/**
 * Lightweight Slack message sender using raw fetch() against the Slack Web API.
 *
 * No dependency on @slack/web-api or @slack/bolt — just HTTP POST with
 * the bot token. Mirrors PushoverService patterns (isConfigured, graceful
 * error handling, configurable via constructor or env var).
 */
export class SlackMessenger {
  private token: string

  constructor(token?: string) {
    this.token = token ?? process.env.SLACK_BOT_TOKEN ?? ''
  }

  get isConfigured(): boolean {
    return this.token.length > 0
  }

  /**
   * Send a message to a Slack channel or DM.
   *
   * @param opts  Channel ID, plain-text fallback, and optional Block Kit blocks
   * @returns     true if sent successfully, false on any error
   */
  async sendMessage(opts: SlackSendOptions): Promise<boolean> {
    if (!this.isConfigured) {
      logger.debug('Slack token not configured — skipping message')
      return false
    }

    const body: Record<string, unknown> = {
      channel: opts.channel,
      text: opts.text,
    }
    if (opts.blocks && opts.blocks.length > 0) {
      body.blocks = opts.blocks
    }

    try {
      logger.debug({ channel: opts.channel }, 'sending Slack message')

      const res = await fetch(SLACK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      })

      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        logger.warn({ status: res.status, channel: opts.channel }, `Slack API HTTP error ${res.status}: ${errorText}`)
        return false
      }

      // Slack API returns 200 even on logical errors — check the `ok` field
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        logger.warn({ error: data.error, channel: opts.channel }, `Slack API error: ${data.error}`)
        return false
      }

      logger.info({ channel: opts.channel }, 'Slack message sent')
      return true
    } catch (err) {
      logger.warn({ err, channel: opts.channel }, 'Slack send failed (non-fatal)')
      return false
    }
  }
}
