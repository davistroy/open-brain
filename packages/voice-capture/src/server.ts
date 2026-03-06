import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import pino from 'pino'
import { TranscriptionService } from './services/transcription.js'
import { ClassificationService } from './services/classification.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const SUPPORTED_FORMATS = new Set(['m4a', 'wav', 'mp3', 'ogg'])

const transcriptionService = new TranscriptionService()
const classificationService = new ClassificationService()

const app = new Hono()

// Request logging
app.use('*', honoLogger())

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'voice-capture',
    timestamp: new Date().toISOString(),
  })
})

/**
 * POST /api/capture
 *
 * Accepts multipart/form-data with:
 *   - file: audio file (.m4a, .wav, .mp3, .ogg)
 *
 * Optional form fields:
 *   - brain_view: target brain view (default: 'personal')
 *   - device: source device hint (default: 'apple_watch')
 *
 * Response: JSON with capture details forwarded from Core API, or error.
 */
app.post('/api/capture', async (c) => {
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Invalid multipart/form-data request', code: 'BAD_REQUEST' }, 400)
  }

  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Missing required field: file', code: 'BAD_REQUEST' }, 400)
  }

  const filename = file.name || 'audio.m4a'
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_FORMATS.has(ext)) {
    return c.json(
      { error: `Unsupported audio format: .${ext}. Supported: ${[...SUPPORTED_FORMATS].join(', ')}`, code: 'BAD_REQUEST' },
      400,
    )
  }

  const brainView = (formData.get('brain_view') as string | null) ?? 'personal'
  const device = (formData.get('device') as string | null) ?? 'apple_watch'

  log.info({ filename, brainView, device }, 'Audio upload received')

  // Step 1: Transcribe
  let transcription
  try {
    const audioBuffer = await file.arrayBuffer()
    transcription = await transcriptionService.transcribe(audioBuffer, filename)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, filename }, 'Transcription failed')
    return c.json({ error: `Transcription failed: ${message}`, code: 'TRANSCRIPTION_ERROR' }, 502)
  }

  if (!transcription.text || transcription.text.trim().length === 0) {
    return c.json({ error: 'Transcription produced empty text', code: 'EMPTY_TRANSCRIPT' }, 422)
  }

  // Step 2: Classify
  let classification
  try {
    classification = await classificationService.classify(transcription.text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err }, 'Classification failed')
    return c.json({ error: `Classification failed: ${message}`, code: 'CLASSIFICATION_ERROR' }, 502)
  }

  // Step 3: POST to Core API
  const coreApiUrl = process.env.CORE_API_URL ?? 'http://core-api:3000'
  const ingestPayload = {
    content: transcription.text,
    capture_type: classification.template,
    brain_view: brainView,
    source: 'voice',
    metadata: {
      source_metadata: {
        device,
        duration_seconds: transcription.duration,
        original_filename: filename,
        language: transcription.language,
      },
      pre_extracted: {
        template: classification.template,
        confidence: classification.confidence,
        fields: classification.fields,
        transcript_raw: classification.transcript_raw,
      },
    },
  }

  const MAX_ATTEMPTS = 3
  const BACKOFF_BASE_MS = 2_000

  let lastError: string | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ingestPayload),
        signal: AbortSignal.timeout(15_000),
      })

      if (res.ok) {
        const created = await res.json()
        log.info(
          { captureId: (created as { id?: string }).id, template: classification.template },
          'Capture created in Core API',
        )
        return c.json({
          ok: true,
          capture: created,
          transcription: {
            text: transcription.text,
            language: transcription.language,
            duration: transcription.duration,
          },
          classification: {
            template: classification.template,
            confidence: classification.confidence,
          },
        })
      }

      const errorBody = await res.text().catch(() => '')
      lastError = `Core API returned HTTP ${res.status}: ${errorBody}`

      // 4xx errors are not retryable
      if (res.status >= 400 && res.status < 500) {
        log.error({ status: res.status, errorBody }, 'Core API rejected capture — not retrying')
        return c.json({ error: lastError, code: 'INGEST_ERROR' }, 502)
      }

      log.warn({ attempt, status: res.status }, 'Core API error — will retry')
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      log.warn({ attempt, err }, 'Core API request failed — will retry')
    }

    if (attempt < MAX_ATTEMPTS) {
      const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  log.error({ lastError }, 'Core API ingest failed after all attempts')
  return c.json(
    { error: `Failed to ingest capture after ${MAX_ATTEMPTS} attempts: ${lastError}`, code: 'INGEST_ERROR' },
    502,
  )
})

// Unknown routes
app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404))

// Start server
const port = Number(process.env.PORT ?? 3001)
serve({ fetch: app.fetch, port }, () => {
  log.info({ port }, 'Voice-capture service listening')
})

export { app }
