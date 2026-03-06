/**
 * Capture handler — processes Slack messages classified as CAPTURE intent.
 *
 * Flow:
 * 1. Detect audio attachments — if present, route to voice-capture endpoint
 * 2. Dedup check via slack_ts in source_metadata (Core API handles dedup via content_hash,
 *    but we also guard against duplicate Slack event delivery with a note in source_metadata)
 * 3. POST /api/v1/captures with content, source: 'slack', source_metadata
 * 4. Poll for pipeline completion (3 attempts × 5s) for fast confirmation
 * 5. Reply in thread with extracted metadata summary
 *
 * Audio routing (Phase 14.4):
 * - Detects audio MIME type files attached to message
 * - Downloads from Slack using url_private + SLACK_BOT_TOKEN
 * - POSTs to VOICE_CAPTURE_URL (/api/capture) as multipart/form-data
 * - Replies with transcription + classification summary
 * - Non-audio files fall through to normal text capture path
 */

import type { GenericMessageEvent } from '@slack/types'
import type { SayFn } from '@slack/bolt'
import type { CoreApiClient, CaptureResult } from '../lib/core-api-client.js'
import { formatCaptureConfirmation, formatError } from '../lib/formatters.js'
import { logger } from '../lib/logger.js'

// ============================================================
// Types
// ============================================================

/** Slack file attachment shape (minimal — only what we need) */
interface SlackFile {
  mimetype?: string
  name?: string
  url_private?: string
  filetype?: string
}

/** Voice-capture API response shape */
interface VoiceCaptureResponse {
  ok: boolean
  capture?: {
    id: string
    capture_type?: string
    brain_view?: string
  }
  transcription?: {
    text: string
    language?: string
    duration?: number
  }
  classification?: {
    template?: string
    confidence?: number
  }
  error?: string
  code?: string
}

// ============================================================
// Constants
// ============================================================

const VOICE_CAPTURE_TIMEOUT_MS = 60_000  // Transcription can take a while on CPU

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

/**
 * Check if a Slack message contains audio attachments.
 * Returns the first audio file found, or undefined.
 */
function findAudioFile(files?: SlackFile[]): SlackFile | undefined {
  if (!files || files.length === 0) return undefined
  return files.find((f) => f.mimetype?.startsWith('audio/'))
}

/**
 * Check if a Slack message contains audio attachments.
 * Returns true if any file has an audio mimetype.
 */
function hasAudioAttachment(files?: SlackFile[]): boolean {
  return findAudioFile(files) !== undefined
}

/**
 * Download a Slack file using url_private and the bot token.
 * Slack requires Bearer token auth to download private files.
 *
 * @param urlPrivate - The url_private from the Slack file object
 * @param slackBotToken - The xoxb- bot token (from env SLACK_BOT_TOKEN)
 * @returns ArrayBuffer of file bytes
 */
async function downloadSlackFile(urlPrivate: string, slackBotToken: string): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const res = await fetch(urlPrivate, {
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw new Error(`Failed to download Slack file: HTTP ${res.status}`)
  }

  const buffer = await res.arrayBuffer()
  const contentType = res.headers.get('content-type') ?? 'audio/mp4'
  return { buffer, contentType }
}

/**
 * POST audio to voice-capture service.
 * Sends as multipart/form-data: file + slack source_metadata fields.
 *
 * @param voiceCaptureUrl - Base URL of voice-capture service
 * @param audioBuffer - The raw audio bytes
 * @param filename - Original filename (used to determine format)
 * @param slackTs - Original Slack message timestamp (stored in metadata)
 * @returns Parsed voice-capture API response
 */
async function postToVoiceCapture(
  voiceCaptureUrl: string,
  audioBuffer: ArrayBuffer,
  filename: string,
  slackTs: string,
): Promise<VoiceCaptureResponse> {
  const form = new FormData()

  // Ensure filename has a valid audio extension — Slack sometimes strips it
  const normalizedFilename = ensureAudioExtension(filename)

  form.append('file', new Blob([audioBuffer]), normalizedFilename)
  form.append('brain_view', 'personal')
  form.append('device', 'slack')
  form.append('slack_ts', slackTs)

  const url = `${voiceCaptureUrl.replace(/\/$/, '')}/api/capture`

  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(VOICE_CAPTURE_TIMEOUT_MS),
  })

  const data = (await res.json()) as VoiceCaptureResponse

  if (!res.ok) {
    const code = data.code ?? 'VOICE_CAPTURE_ERROR'
    throw new Error(`Voice-capture error [${code}]: ${data.error ?? `HTTP ${res.status}`}`)
  }

  return data
}

/**
 * Ensure the filename has a known audio extension.
 * Slack voice memos sometimes arrive as "audio_message" without extension.
 */
function ensureAudioExtension(filename: string): string {
  const knownExtensions = ['.m4a', '.mp3', '.wav', '.ogg', '.mp4']
  const hasExtension = knownExtensions.some((ext) => filename.toLowerCase().endsWith(ext))
  if (hasExtension) return filename
  // Default to .m4a (most common for iOS/Slack voice clips)
  return `${filename}.m4a`
}

/**
 * Format a thread reply summarising the voice-capture result.
 */
function formatVoiceCaptureReply(result: VoiceCaptureResponse): string {
  const transcript = result.transcription?.text ?? ''
  const captureType = result.classification?.template ?? result.capture?.capture_type ?? 'observation'
  const confidence = result.classification?.confidence

  const parts: string[] = [
    `:microphone: *Voice captured as ${captureType}*`,
  ]

  if (confidence !== undefined) {
    parts.push(`_(${Math.round(confidence * 100)}% confidence)_`)
  }

  if (transcript) {
    // Truncate long transcripts for thread reply
    const preview = transcript.length > 300 ? transcript.slice(0, 300) + '…' : transcript
    parts.push(`\n> ${preview}`)
  }

  return parts.join(' ')
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
  const msgFiles = (message.files as SlackFile[] | undefined)

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

// ============================================================
// Audio capture sub-handler
// ============================================================

/**
 * Handle a Slack message with an audio file attachment.
 *
 * 1. Find the audio file in the message's files array
 * 2. Download from Slack using url_private + bot token
 * 3. POST to voice-capture service as multipart/form-data
 * 4. Reply in thread with transcription + classification result
 *
 * Errors are caught and reported as thread replies; never throws.
 */
async function handleAudioCapture(
  message: GenericMessageEvent,
  say: SayFn,
  slackBotToken?: string,
  voiceCaptureUrl?: string,
): Promise<void> {
  const ts = message.ts
  const channel = message.channel
  const user = 'user' in message ? (message.user ?? 'unknown') : 'unknown'

  const audioFile = findAudioFile(message.files as SlackFile[] | undefined)
  if (!audioFile) {
    // Should not happen since hasAudioAttachment() returned true, but guard anyway
    logger.warn({ ts, channel }, 'handleAudioCapture: audio file not found in files array')
    return
  }

  logger.info(
    { channel, ts, user, filename: audioFile.name, mimetype: audioFile.mimetype },
    'handleAudioCapture: audio attachment detected',
  )

  const token = slackBotToken ?? process.env.SLACK_BOT_TOKEN
  const vcUrl = voiceCaptureUrl ?? process.env.VOICE_CAPTURE_URL

  // If bot token is missing, we can't download the file — report as error
  if (!token) {
    logger.error({ channel, ts }, 'handleAudioCapture: SLACK_BOT_TOKEN not configured — cannot download audio')
    await say({
      text: formatError('Voice capture failed', 'SLACK_BOT_TOKEN not configured — cannot download audio file'),
      thread_ts: ts,
    })
    return
  }

  // If voice-capture URL is not configured, report as error
  if (!vcUrl) {
    logger.error({ channel, ts }, 'handleAudioCapture: VOICE_CAPTURE_URL not configured')
    await say({
      text: formatError('Voice capture failed', 'VOICE_CAPTURE_URL not configured — cannot route audio to transcription service'),
      thread_ts: ts,
    })
    return
  }

  // url_private is required to download the file
  if (!audioFile.url_private) {
    logger.error({ channel, ts, filename: audioFile.name }, 'handleAudioCapture: url_private missing on audio file')
    await say({
      text: formatError('Voice capture failed', 'Audio file has no download URL (url_private missing)'),
      thread_ts: ts,
    })
    return
  }

  // Acknowledge immediately — transcription takes time
  await say({
    text: '_Transcribing voice memo…_',
    thread_ts: ts,
  })

  // Download from Slack
  let audioBuffer: ArrayBuffer
  try {
    const downloaded = await downloadSlackFile(audioFile.url_private, token)
    audioBuffer = downloaded.buffer
  } catch (err) {
    logger.error({ err, channel, ts, filename: audioFile.name }, 'handleAudioCapture: Slack download failed')
    await say({
      text: formatError('Voice capture failed', `Could not download audio from Slack: ${err instanceof Error ? err.message : String(err)}`),
      thread_ts: ts,
    })
    return
  }

  const filename = audioFile.name ?? 'voice-memo.m4a'

  // POST to voice-capture service
  let result: VoiceCaptureResponse
  try {
    result = await postToVoiceCapture(vcUrl, audioBuffer, filename, ts)
  } catch (err) {
    logger.error({ err, channel, ts, filename }, 'handleAudioCapture: voice-capture POST failed')
    await say({
      text: formatError('Voice capture failed', err),
      thread_ts: ts,
    })
    return
  }

  // Reply with transcription result
  const replyText = formatVoiceCaptureReply(result)
  await say({
    text: replyText,
    thread_ts: ts,
  })

  logger.info(
    {
      captureId: result.capture?.id,
      captureType: result.capture?.capture_type,
      transcriptLen: result.transcription?.text?.length,
      channel,
      ts,
    },
    'handleAudioCapture: complete',
  )
}
