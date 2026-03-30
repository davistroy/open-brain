/**
 * Capture handler — processes Slack messages classified as CAPTURE intent.
 *
 * Flow:
 * 1. Detect audio attachments — if present, route to voice-capture handler
 * 2. Dedup check via slack_ts in source_metadata (Core API handles dedup via content_hash,
 *    but we also guard against duplicate Slack event delivery with a note in source_metadata)
 * 3. POST /api/v1/captures with content, source: 'slack', source_metadata
 * 4. Poll for pipeline completion (3 attempts × 5s) for fast confirmation
 * 5. Reply in thread with extracted metadata summary
 *
 * Audio routing delegated to voice-capture.ts (Phase 29 split).
 */

import type { GenericMessageEvent } from '@slack/types'
import type { SayFn } from '@slack/bolt'
import type { CoreApiClient, CaptureResult } from '../lib/core-api-client.js'
import { formatCaptureConfirmation, formatError } from '../lib/formatters.js'
import { logger } from '@open-brain/shared'
import { handleAudioCapture, hasAudioAttachment } from './voice-capture.js'

// ============================================================
// Helpers
// ============================================================

/**
 * Poll Core API for pipeline completion on the newly created capture.
 * Returns the latest capture record once pipeline_status is not 'received'
 * or 'processing', or returns the last polled record if max attempts exceeded.
 *
 * @param client - CoreApiClient instance
 * @param captureId - ID of the capture to poll
 * @param maxAttempts - Number of poll attempts (default: 3)
 * @param intervalMs - Milliseconds between attempts (default: 5000)
 */
async function pollForCompletion(
  client: CoreApiClient,
  captureId: string,
  maxAttempts = 3,
  intervalMs = 5_000,
): Promise<CaptureResult> {
  let latest = await client.captures_get(captureId)

  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    if (latest.pipeline_status !== 'received' && latest.pipeline_status !== 'processing') {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
    try {
      latest = await client.captures_get(captureId)
    } catch (err) {
      logger.warn({ err, captureId, attempt }, 'Poll attempt failed — using last known state')
      break
    }
  }

  return latest
}

// ============================================================
// Main handler
// ============================================================

/**
 * Main capture handler. Called by server.ts when IntentRouter returns intent = 'capture'.
 *
 * @param message - The Slack GenericMessageEvent
 * @param say - Bolt's say() function, scoped to the current channel
 * @param coreApiClient - Initialized CoreApiClient
 * @param slackBotToken - Slack bot token for downloading private files (default: env SLACK_BOT_TOKEN)
 * @param voiceCaptureUrl - Voice-capture service URL (default: env VOICE_CAPTURE_URL)
 */
export async function handleCapture(
  message: GenericMessageEvent,
  say: SayFn,
  coreApiClient: CoreApiClient,
  slackBotToken?: string,
  voiceCaptureUrl?: string,
): Promise<void> {
  const msgFiles = (message.files as Array<{ mimetype?: string }> | undefined)

  // --- Audio attachment routing ---
  if (hasAudioAttachment(msgFiles)) {
    await handleAudioCapture(message, say, slackBotToken, voiceCaptureUrl)
    return
  }

  // --- Text capture path ---

  // Require text content — guard against edge cases
  if (!('text' in message) || !message.text) {
    logger.debug({ ts: message.ts }, 'handleCapture: empty text, skipping')
    return
  }

  const text = message.text.trim()
  const channel = message.channel
  const ts = message.ts
  const user = 'user' in message ? (message.user ?? 'unknown') : 'unknown'
  const threadTs = 'thread_ts' in message ? message.thread_ts : undefined

  logger.info({ channel, ts, user, textLen: text.length }, 'handleCapture: processing')

  // --- Create capture via Core API ---
  let capture: CaptureResult
  try {
    capture = await coreApiClient.captures_create({
      content: text,
      capture_type: 'observation',     // Default; pipeline metadata extraction will refine
      brain_view: 'personal',           // Default; pipeline will reclassify via brain-views config
      source: 'slack',
      metadata: {
        source_metadata: {
          slack_ts: ts,
          channel,
          user,
          thread_ts: threadTs,
        },
      },
    })
  } catch (err) {
    // 409 Conflict from Core API → already captured (content_hash dedup)
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg.includes('409') || errMsg.toLowerCase().includes('conflict')) {
      logger.info({ channel, ts }, 'handleCapture: duplicate slack_ts or content, already captured')
      await say({
        text: '_Already captured._',
        thread_ts: ts,
      })
      return
    }

    logger.error({ err, channel, ts }, 'handleCapture: Core API create failed')
    await say({
      text: formatError('Capture failed', err),
      thread_ts: ts,
    })
    return
  }

  // --- Poll for pipeline metadata (best-effort, 3 × 5s) ---
  let enriched: CaptureResult = capture
  try {
    enriched = await pollForCompletion(coreApiClient, capture.id)
  } catch (err) {
    // Non-fatal — we still have the base capture record
    logger.warn({ err, captureId: capture.id }, 'handleCapture: pipeline poll failed, using initial record')
  }

  // --- Reply in thread ---
  const confirmationText = formatCaptureConfirmation(enriched)
  await say({
    text: confirmationText,
    thread_ts: ts,
  })

  logger.info(
    { captureId: enriched.id, pipeline_status: enriched.pipeline_status, channel, ts },
    'handleCapture: complete',
  )
}
