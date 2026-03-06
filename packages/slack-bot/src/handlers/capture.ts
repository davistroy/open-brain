/**
 * Capture handler — processes Slack messages classified as CAPTURE intent.
 *
 * Flow:
 * 1. Dedup check via slack_ts in source_metadata (Core API handles dedup via content_hash,
 *    but we also guard against duplicate Slack event delivery with a note in source_metadata)
 * 2. POST /api/v1/captures with content, source: 'slack', source_metadata
 * 3. Poll for pipeline completion (3 attempts × 5s) for fast confirmation
 * 4. Reply in thread with extracted metadata summary
 * 5. Detect audio attachments and note routing (Phase 9 wires voice-capture endpoint)
 */

import type { GenericMessageEvent } from '@slack/bolt'
import type { SayFn } from '@slack/bolt'
import type { CoreApiClient, CaptureResult } from '../lib/core-api-client.js'
import { formatCaptureConfirmation, formatError } from '../lib/formatters.js'
import { logger } from '../lib/logger.js'

/** Slack file attachment shape (minimal — only what we need) */
interface SlackFile {
  mimetype?: string
  name?: string
  url_private?: string
}

interface MessageWithFiles extends GenericMessageEvent {
  files?: SlackFile[]
}

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

/**
 * Check if a Slack message contains audio attachments.
 * Returns true if any file has an audio mimetype.
 */
function hasAudioAttachment(files?: SlackFile[]): boolean {
  if (!files || files.length === 0) return false
  return files.some((f) => f.mimetype?.startsWith('audio/'))
}

/**
 * Main capture handler. Called by server.ts when IntentRouter returns intent = 'capture'.
 *
 * @param message - The Slack GenericMessageEvent
 * @param say - Bolt's say() function, scoped to the current channel
 * @param coreApiClient - Initialized CoreApiClient
 */
export async function handleCapture(
  message: MessageWithFiles,
  say: SayFn,
  coreApiClient: CoreApiClient,
): Promise<void> {
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

  // --- Audio attachment routing (Phase 9 wires voice-capture endpoint) ---
  if (hasAudioAttachment(message.files)) {
    logger.info({ channel, ts, user }, 'handleCapture: audio attachment detected, routing to voice-capture (Phase 9)')
    await say({
      text: '_Audio message received. Voice-capture processing is coming in Phase 9._',
      thread_ts: ts,
    })
    return
  }

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
