import { timingSafeEqual } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { createLogger } from '@open-brain/shared'
import { TranscriptionService } from './services/transcription.js'
import { ClassificationService } from './services/classification.js'
import { IngestService } from './services/ingest.js'
import { NotificationService } from './services/notification.js'
import { getValidBrainViews } from './lib/brain-views.js'
import { spoolTranscript, removeSpooled, retrySpooledTranscripts } from './lib/transcript-spool.js'

const log = createLogger('voice-capture')

if (!process.env.OPENAI_API_KEY) {
  log.warn('OPENAI_API_KEY not set — voice classification will fail')
}

if (!process.env.VOICE_CAPTURE_SECRET) {
  log.warn(
    'VOICE_CAPTURE_SECRET not set — POST /api/capture is UNAUTHENTICATED (pre-rollout warn-and-allow). ' +
      'Set it to enforce Bearer auth (INT-M5).',
  )
}

const SUPPORTED_FORMATS = new Set(['m4a', 'wav', 'mp3', 'ogg'])

/**
 * Timing-safe constant-time string comparison (INT-M5). Returns false on a
 * length mismatch (the only timing side-channel left is the length, which is
 * the standard, accepted trade-off for `timingSafeEqual`).
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const transcriptionService = new TranscriptionService()
const classificationService = new ClassificationService()
const ingestService = new IngestService()
const notificationService = new NotificationService()

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
 *   - latitude: GPS latitude as string (-90 to +90, requires longitude)
 *   - longitude: GPS longitude as string (-180 to +180, requires latitude)
 *   - location_name: reverse-geocoded place name from iOS
 *   - location_accuracy: horizontal accuracy in meters from CLLocation
 *
 * Response: JSON with capture details forwarded from Core API, or error.
 */
app.post('/api/capture', async (c) => {
  // INT-M5: Bearer auth. Enforced only when VOICE_CAPTURE_SECRET is configured
  // (fail-closed once set); unset = pre-rollout warn-and-allow so deploying the
  // code before the operator updates clients + sets the secret can't break the
  // running service (two-phase rollout: clients send token → then set secret).
  const secret = process.env.VOICE_CAPTURE_SECRET
  if (secret) {
    const authHeader = c.req.header('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token || !safeEqual(token, secret)) {
      return c.json({ error: 'Invalid or missing Bearer token', code: 'UNAUTHORIZED' }, 401)
    }
  }

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

  // PE-L4: reject oversized uploads BEFORE paid transcription. Configurable via
  // VOICE_MAX_UPLOAD_BYTES (default 50 MB); read per-request so it stays testable.
  const maxUploadBytes = Number(process.env.VOICE_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024)
  if (file.size > maxUploadBytes) {
    return c.json(
      { error: `Audio file too large: ${file.size} bytes (max ${maxUploadBytes})`, code: 'PAYLOAD_TOO_LARGE' },
      413,
    )
  }

  const brainView = (formData.get('brain_view') as string | null) ?? 'personal'
  const device = (formData.get('device') as string | null) ?? 'apple_watch'

  // SE-13: validate brain_view against config BEFORE paid transcription. core-api
  // re-validates at ingest, but failing here avoids paying for transcription +
  // classification on a brain_view that ingest would reject. Skipped (null) when
  // the config can't be loaded — graceful, core-api remains the backstop.
  const validBrainViews = getValidBrainViews()
  if (validBrainViews && !validBrainViews.includes(brainView)) {
    return c.json(
      { error: `Invalid brain_view: ${brainView}. Valid values: ${validBrainViews.join(', ')}`, code: 'BAD_REQUEST' },
      400,
    )
  }

  // Parse optional location fields (1.1)
  const rawLat = formData.get('latitude') as string | null
  const rawLng = formData.get('longitude') as string | null
  const rawLocationName = formData.get('location_name') as string | null
  const rawLocationAccuracy = formData.get('location_accuracy') as string | null

  // Build location object if any location fields are present (1.3, 1.4)
  let location: { latitude: number; longitude: number; name?: string; accuracy_meters?: number } | undefined

  if (rawLat != null || rawLng != null) {
    // Require both lat+lng or neither (1.2)
    if (rawLat == null || rawLng == null) {
      return c.json(
        { error: 'Both latitude and longitude are required when providing location', code: 'BAD_REQUEST' },
        400,
      )
    }

    const latitude = parseFloat(rawLat)
    const longitude = parseFloat(rawLng)

    // Reject non-numeric values (1.1)
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return c.json(
        { error: 'latitude and longitude must be valid numbers', code: 'BAD_REQUEST' },
        400,
      )
    }

    // Validate coordinate ranges (1.2)
    if (latitude < -90 || latitude > 90) {
      return c.json(
        { error: 'latitude must be between -90 and 90', code: 'BAD_REQUEST' },
        400,
      )
    }
    if (longitude < -180 || longitude > 180) {
      return c.json(
        { error: 'longitude must be between -180 and 180', code: 'BAD_REQUEST' },
        400,
      )
    }

    location = { latitude, longitude }

    if (rawLocationName != null && rawLocationName.trim().length > 0) {
      location.name = rawLocationName.trim()
    }

    if (rawLocationAccuracy != null) {
      const accuracy = parseFloat(rawLocationAccuracy)
      if (Number.isNaN(accuracy)) {
        return c.json(
          { error: 'location_accuracy must be a valid number', code: 'BAD_REQUEST' },
          400,
        )
      }
      location.accuracy_meters = accuracy
    }
  }

  log.info({ filename, brainView, device, hasLocation: !!location }, 'Audio upload received')

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

  // Step 3: POST to Core API via IngestService (handles retry)
  const ingestPayload = {
    content: transcription.text,
    capture_type: classification.template,
    brain_view: brainView,
    source: 'voice' as const,
    tags: ['voice'],
    metadata: {
      source_metadata: {
        device,
        duration_seconds: transcription.duration,
        original_filename: filename,
        language: transcription.language,
        ...(location ? { location } : {}),
      },
      pre_extracted: {
        template: classification.template,
        confidence: classification.confidence,
        fields: classification.fields,
        transcript_raw: classification.transcript_raw,
      },
    },
  }

  // INT-M4: write-ahead spool so a transient core-api outage never loses a
  // transcribed memo. Spool BEFORE ingest, delete on success; on failure the
  // file survives for the periodic retry sweep. Best-effort — if spooling itself
  // fails (e.g. volume unavailable) we log and continue rather than drop the capture.
  let spoolPath: string | undefined
  try {
    spoolPath = await spoolTranscript(ingestPayload)
  } catch (err) {
    log.warn({ err }, 'Failed to spool transcript — dead-letter safety net unavailable')
  }

  let created
  try {
    created = await ingestService.ingest(ingestPayload)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, spooled: !!spoolPath }, 'Core API ingest failed — transcript spooled for retry')
    return c.json({ error: message, code: 'INGEST_ERROR', spooled: !!spoolPath }, 502)
  }

  if (spoolPath) await removeSpooled(spoolPath)

  // Step 4: Pushover notification (non-blocking, failure is non-fatal)
  const topicsField = classification.fields.find((f) => f.name === 'topics')
  const topics = topicsField?.value ?? ''
  const snippet = transcription.text.slice(0, 120)

  await notificationService.notifyCaptureSuccess({
    captureId: created.id,
    captureType: classification.template,
    brainView,
    topics,
    snippet,
  })

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
})

// Unknown routes
app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404))

// INT-M4: periodically re-ingest dead-lettered transcripts. Gated out of tests
// (NODE_ENV=test) and unref'd so it never keeps the process alive.
if (process.env.NODE_ENV !== 'test') {
  const retryMs = Number(process.env.VOICE_SPOOL_RETRY_MS ?? 30 * 60 * 1000)
  const timer = setInterval(() => {
    retrySpooledTranscripts((p) => ingestService.ingest(p as Parameters<typeof ingestService.ingest>[0]))
      .then((r) => {
        if (r.retried > 0) log.info(r, 'Dead-letter spool retry sweep complete')
      })
      .catch((err) => log.warn({ err }, 'Dead-letter spool retry sweep failed'))
  }, retryMs)
  timer.unref()
}

// Start server
const port = Number(process.env.PORT ?? 3001)
serve({ fetch: app.fetch, port }, () => {
  log.info({ port }, 'Voice-capture service listening')
})

export { app }
