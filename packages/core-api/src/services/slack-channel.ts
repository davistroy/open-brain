import { WebClient } from '@slack/web-api'
import { logger } from '../lib/logger.js'

export interface SlackChannelInfo {
  id: string
  name: string
  member_count: number
  last_activity: string | null
  days_inactive: number
  topic?: string
  purpose?: string
  is_archived: boolean
}

export interface ArchiveResult {
  ok: boolean
  channel_id: string
  archived_at: string
}

/**
 * Service for listing and archiving Slack channels.
 * Uses a Slack user token (xoxp-...) which requires scopes:
 *   channels:read, channels:history, channels:write (for archive)
 */
export class SlackChannelService {
  private client: WebClient

  constructor(slackUserToken: string) {
    this.client = new WebClient(slackUserToken)
  }

  /**
   * List all non-DM channels the token has access to, with activity metadata.
   * Paginates through conversations.list and fetches latest message timestamp
   * from conversations.history (limit 1) to compute days_inactive.
   */
  async listChannels(): Promise<SlackChannelInfo[]> {
    const channels: SlackChannelInfo[] = []
    let cursor: string | undefined

    // Paginate through all channels
    do {
      const result = await this.client.conversations.list({
        types: 'public_channel',
        exclude_archived: false,
        limit: 200,
        cursor,
      })

      if (!result.channels) break

      for (const ch of result.channels) {
        if (!ch.id || !ch.name) continue

        let lastActivity: string | null = null
        let daysInactive = 0

        // Only fetch history for non-archived channels
        if (!ch.is_archived) {
          try {
            const history = await this.client.conversations.history({
              channel: ch.id,
              limit: 1,
            })

            if (history.messages && history.messages.length > 0 && history.messages[0].ts) {
              const ts = parseFloat(history.messages[0].ts)
              const messageDate = new Date(ts * 1000)
              lastActivity = messageDate.toISOString()
              daysInactive = Math.floor(
                (Date.now() - messageDate.getTime()) / (1000 * 60 * 60 * 24),
              )
            }
          } catch (err) {
            // Bot may not have access to all channels — log and skip
            logger.debug(
              { channel: ch.name, err },
              'Could not fetch history for channel',
            )
          }
        }

        channels.push({
          id: ch.id,
          name: ch.name,
          member_count: ch.num_members ?? 0,
          last_activity: lastActivity,
          days_inactive: daysInactive,
          topic: ch.topic?.value || undefined,
          purpose: ch.purpose?.value || undefined,
          is_archived: ch.is_archived ?? false,
        })
      }

      cursor = result.response_metadata?.next_cursor || undefined
    } while (cursor)

    return channels
  }

  /**
   * Archive a Slack channel by ID.
   * Requires channels:write scope on the user token.
   */
  async archiveChannel(channelId: string): Promise<ArchiveResult> {
    await this.client.conversations.archive({ channel: channelId })
    return {
      ok: true,
      channel_id: channelId,
      archived_at: new Date().toISOString(),
    }
  }
}
