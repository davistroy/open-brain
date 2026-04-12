/**
 * Block Kit message builder for auto-response DM delivery (assist mode).
 *
 * Builds a rich message with:
 * - Original question context (channel, user, link)
 * - Draft response text
 * - Confidence score
 * - Three action buttons: Post Reply, Edit & Post, Dismiss
 *
 * Action metadata is encoded in button values as JSON so action handlers
 * can reconstruct the original context without external storage.
 */

import type { KnownBlock, Block } from '@slack/types'

/** Context needed to build a DM draft message */
export interface DraftDMContext {
  /** Original channel where the question was asked */
  channel: string
  /** Timestamp of the original message (used as thread_ts for replies) */
  threadTs: string
  /** User who asked the question */
  userId: string
  /** Full formatted draft response (Slack mrkdwn) */
  draft: string
  /** Short summary of the draft */
  summary: string
  /** Composite confidence score (0-1) */
  confidence: number
  /** Number of corroborating search results */
  sourceCount: number
  /** Original question text */
  originalText: string
}

/** Metadata encoded in action button values */
export interface ActionMetadata {
  /** Original channel ID */
  channel: string
  /** Thread timestamp for reply */
  thread_ts: string
  /** User who asked the question */
  user: string
  /** Draft response text */
  draft: string
}

/**
 * Encode action metadata into a button value string.
 * Slack button values have a 2000 char limit. If the draft is too long,
 * truncate it to fit within limits.
 */
export function encodeActionMetadata(meta: ActionMetadata): string {
  // Reserve ~200 chars for the JSON wrapper and other fields
  const maxDraftLen = 1700
  const truncated = meta.draft.length > maxDraftLen
    ? meta.draft.slice(0, maxDraftLen) + '\n\n_[Draft truncated for button action -- full draft in message above]_'
    : meta.draft
  return JSON.stringify({ ...meta, draft: truncated })
}

/**
 * Decode action metadata from a button value string.
 * Returns null if parsing fails.
 */
export function decodeActionMetadata(value: string): ActionMetadata | null {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed.channel === 'string' && typeof parsed.thread_ts === 'string') {
      return parsed as ActionMetadata
    }
    return null
  } catch {
    return null
  }
}

/**
 * Build Block Kit blocks for the auto-response DM message.
 * Returns an array of Slack Block Kit blocks.
 */
export function buildDraftDMBlocks(ctx: DraftDMContext): (KnownBlock | Block)[] {
  const confidencePercent = (ctx.confidence * 100).toFixed(0)
  const messageLink = `https://slack.com/archives/${ctx.channel}/p${ctx.threadTs.replace('.', '')}`
  const questionPreview = ctx.originalText.length > 200
    ? ctx.originalText.slice(0, 200) + '...'
    : ctx.originalText

  const actionMeta: ActionMetadata = {
    channel: ctx.channel,
    thread_ts: ctx.threadTs,
    user: ctx.userId,
    draft: ctx.draft,
  }
  const metaValue = encodeActionMetadata(actionMeta)

  const blocks: (KnownBlock | Block)[] = [
    // Header
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Auto-Response Draft (${confidencePercent}% confidence)`,
        emoji: true,
      },
    },
    // Original question context
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Question from* <@${ctx.userId}> in <#${ctx.channel}>:\n>${questionPreview}`,
      },
      accessory: {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'View Message',
          emoji: true,
        },
        url: messageLink,
        action_id: 'view_original_message',
      },
    },
    { type: 'divider' },
    // Draft response
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft Response:*\n${ctx.summary}`,
      },
    },
    // Metadata line
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Confidence: *${confidencePercent}%* | Sources: *${ctx.sourceCount}* corroborating captures`,
        },
      ],
    },
    { type: 'divider' },
    // Action buttons
    {
      type: 'actions',
      block_id: 'auto_response_actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Post as Reply',
            emoji: true,
          },
          style: 'primary',
          action_id: 'post_reply',
          value: metaValue,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Edit & Post',
            emoji: true,
          },
          action_id: 'edit_post',
          value: metaValue,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Dismiss',
            emoji: true,
          },
          style: 'danger',
          action_id: 'dismiss',
          value: metaValue,
        },
      ],
    },
  ]

  return blocks
}

/**
 * Build updated DM blocks after an action is taken.
 * Replaces the action buttons with a status message.
 */
export function buildActionConfirmationBlocks(
  originalBlocks: (KnownBlock | Block)[],
  status: 'Posted' | 'Dismissed' | 'Edited & Posted',
): (KnownBlock | Block)[] {
  // Filter out the actions block and add a status context block
  const filtered = originalBlocks.filter(
    b => !('block_id' in b && b.block_id === 'auto_response_actions')
  )

  filtered.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `*Status:* ${status}`,
      },
    ],
  })

  return filtered
}
