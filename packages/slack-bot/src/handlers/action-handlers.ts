/**
 * Interactive action handlers for auto-response DM buttons.
 *
 * Three actions:
 * - post_reply: Post draft as threaded reply in original channel
 * - edit_post: Open modal with editable draft, post edited text on submit
 * - dismiss: Acknowledge, update DM to "Dismissed", log for tuning
 *
 * All handlers decode the original message context from the button value
 * (ActionMetadata JSON) and update the DM message to reflect the action taken.
 */

import type { App } from '@slack/bolt'
import { logger } from '@open-brain/shared'
import { decodeActionMetadata, buildActionConfirmationBlocks } from '../services/dm-blocks.js'

/** Modal callback ID for the edit_post flow */
export const EDIT_POST_MODAL_CALLBACK = 'auto_response_edit_modal'

/** Block ID for the draft text input in the modal */
export const DRAFT_INPUT_BLOCK_ID = 'draft_input_block'

/** Action ID for the draft text input */
export const DRAFT_INPUT_ACTION_ID = 'draft_input'

/**
 * Register all interactive action handlers on the Bolt app.
 */
export function registerActionHandlers(app: App): void {
  // --- Post Reply ---
  app.action('post_reply', async ({ ack, body, client, action }) => {
    await ack()

    try {
      const buttonAction = action as { value?: string }
      const meta = buttonAction.value ? decodeActionMetadata(buttonAction.value) : null
      if (!meta) {
        logger.warn('[action:post_reply] missing or invalid action metadata')
        return
      }

      // Post draft as threaded reply in original channel
      await client.chat.postMessage({
        channel: meta.channel,
        thread_ts: meta.thread_ts,
        text: meta.draft,
      })

      logger.info(
        { channel: meta.channel, thread_ts: meta.thread_ts },
        '[action:post_reply] posted draft as threaded reply',
      )

      // Update DM message to show "Posted" status
      const blockBody = body as { channel?: { id: string }; message?: { ts: string; blocks?: unknown[] } }
      if (blockBody.channel?.id && blockBody.message?.ts) {
        const originalBlocks = (blockBody.message.blocks ?? []) as Parameters<typeof buildActionConfirmationBlocks>[0]
        await client.chat.update({
          channel: blockBody.channel.id,
          ts: blockBody.message.ts,
          text: 'Auto-response draft -- Posted',
          blocks: buildActionConfirmationBlocks(originalBlocks, 'Posted'),
        })
      }
    } catch (err) {
      logger.error({ err }, '[action:post_reply] failed')
    }
  })

  // --- Edit & Post ---
  app.action('edit_post', async ({ ack, body, client, action }) => {
    await ack()

    try {
      const buttonAction = action as { value?: string }
      const meta = buttonAction.value ? decodeActionMetadata(buttonAction.value) : null
      if (!meta) {
        logger.warn('[action:edit_post] missing or invalid action metadata')
        return
      }

      const triggerBody = body as { trigger_id: string; channel?: { id: string }; message?: { ts: string } }

      // Store DM message info in private_metadata so we can update it after submission
      const privateMetadata = JSON.stringify({
        ...meta,
        dm_channel: triggerBody.channel?.id,
        dm_ts: triggerBody.message?.ts,
      })

      // Open modal with editable draft text
      await client.views.open({
        trigger_id: triggerBody.trigger_id,
        view: {
          type: 'modal',
          callback_id: EDIT_POST_MODAL_CALLBACK,
          private_metadata: privateMetadata,
          title: {
            type: 'plain_text',
            text: 'Edit Response',
          },
          submit: {
            type: 'plain_text',
            text: 'Post Reply',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Replying to <@${meta.user}> in <#${meta.channel}>`,
              },
            },
            {
              type: 'input',
              block_id: DRAFT_INPUT_BLOCK_ID,
              element: {
                type: 'plain_text_input',
                action_id: DRAFT_INPUT_ACTION_ID,
                multiline: true,
                initial_value: meta.draft,
              },
              label: {
                type: 'plain_text',
                text: 'Draft Response',
              },
            },
          ],
        },
      })

      logger.info(
        { channel: meta.channel, thread_ts: meta.thread_ts },
        '[action:edit_post] opened edit modal',
      )
    } catch (err) {
      logger.error({ err }, '[action:edit_post] failed to open modal')
    }
  })

  // --- Dismiss ---
  app.action('dismiss', async ({ ack, body, client, action }) => {
    await ack()

    try {
      const buttonAction = action as { value?: string }
      const meta = buttonAction.value ? decodeActionMetadata(buttonAction.value) : null
      if (!meta) {
        logger.warn('[action:dismiss] missing or invalid action metadata')
        return
      }

      logger.info(
        { channel: meta.channel, thread_ts: meta.thread_ts, user: meta.user },
        '[action:dismiss] draft dismissed -- logged for tuning',
      )

      // Update DM message to show "Dismissed" status
      const blockBody = body as { channel?: { id: string }; message?: { ts: string; blocks?: unknown[] } }
      if (blockBody.channel?.id && blockBody.message?.ts) {
        const originalBlocks = (blockBody.message.blocks ?? []) as Parameters<typeof buildActionConfirmationBlocks>[0]
        await client.chat.update({
          channel: blockBody.channel.id,
          ts: blockBody.message.ts,
          text: 'Auto-response draft -- Dismissed',
          blocks: buildActionConfirmationBlocks(originalBlocks, 'Dismissed'),
        })
      }
    } catch (err) {
      logger.error({ err }, '[action:dismiss] failed')
    }
  })

  // --- View Original Message (link button, no-op -- Slack handles the URL) ---
  app.action('view_original_message', async ({ ack }) => {
    await ack()
    // URL buttons are handled by Slack natively, but Bolt still receives the action
  })

  // --- Modal submission for edit_post flow ---
  app.view(EDIT_POST_MODAL_CALLBACK, async ({ ack, view, client }) => {
    await ack()

    try {
      const privateMeta = JSON.parse(view.private_metadata) as {
        channel: string
        thread_ts: string
        user: string
        dm_channel?: string
        dm_ts?: string
      }

      // Extract edited text from the modal input
      const editedDraft = view.state.values[DRAFT_INPUT_BLOCK_ID]?.[DRAFT_INPUT_ACTION_ID]?.value
      if (!editedDraft) {
        logger.warn('[view:edit_post] no draft text in modal submission')
        return
      }

      // Post edited draft as threaded reply in original channel
      await client.chat.postMessage({
        channel: privateMeta.channel,
        thread_ts: privateMeta.thread_ts,
        text: editedDraft,
      })

      logger.info(
        { channel: privateMeta.channel, thread_ts: privateMeta.thread_ts },
        '[view:edit_post] posted edited draft as threaded reply',
      )

      // Update DM message to show "Edited & Posted" status
      if (privateMeta.dm_channel && privateMeta.dm_ts) {
        try {
          // Fetch the original DM message to get its blocks
          const msgResult = await client.conversations.history({
            channel: privateMeta.dm_channel,
            latest: privateMeta.dm_ts,
            inclusive: true,
            limit: 1,
          })
          const originalBlocks = ((msgResult.messages?.[0]?.blocks ?? []) as Parameters<typeof buildActionConfirmationBlocks>[0])
          await client.chat.update({
            channel: privateMeta.dm_channel,
            ts: privateMeta.dm_ts,
            text: 'Auto-response draft -- Edited & Posted',
            blocks: buildActionConfirmationBlocks(originalBlocks, 'Edited & Posted'),
          })
        } catch (updateErr) {
          logger.warn({ err: updateErr }, '[view:edit_post] failed to update DM message')
        }
      }
    } catch (err) {
      logger.error({ err }, '[view:edit_post] failed')
    }
  })

  logger.info('Auto-response action handlers registered')
}
