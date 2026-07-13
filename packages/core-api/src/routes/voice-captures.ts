import type { Hono } from 'hono'
import { ValidationError, logger } from '@open-brain/shared'

const VOICE_CAPTURE_URL =
  process.env.VOICE_CAPTURE_URL ?? 'http://voice-capture:3001/api/capture'

export function registerVoiceCaptureRoutes(app: Hono): void {
  app.post('/api/v1/voice-captures', async (c) => {
    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      throw new ValidationError('Request must be multipart/form-data')
    }

    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      throw new ValidationError('Missing required field: file')
    }

    // PE-L4: reject oversized uploads before proxying (and before the upstream
    // pays for transcription). Configurable via VOICE_MAX_UPLOAD_BYTES (default 50 MB).
    const maxUploadBytes = Number(process.env.VOICE_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024)
    if (file.size > maxUploadBytes) {
      return c.json(
        { error: `Audio file too large: ${file.size} bytes (max ${maxUploadBytes})`, code: 'PAYLOAD_TOO_LARGE' },
        413,
      )
    }

    const upstreamForm = new FormData()
    for (const [key, value] of formData.entries()) {
      upstreamForm.append(key, value)
    }

    // INT-M5: forward the voice-capture Bearer upstream when configured, so the
    // web/proxy voice path keeps working once voice-capture enforces auth. The
    // R2 boundary caller header is preserved (this is server-to-server on the
    // docker network; the public caller identity is still web-next-public).
    const upstreamHeaders: Record<string, string> = { 'X-Open-Brain-Caller': 'web-next-public' }
    const voiceSecret = process.env.VOICE_CAPTURE_SECRET
    if (voiceSecret) upstreamHeaders['Authorization'] = `Bearer ${voiceSecret}`

    const t0 = Date.now()
    let response: Response
    try {
      response = await fetch(VOICE_CAPTURE_URL, {
        method: 'POST',
        headers: upstreamHeaders,
        body: upstreamForm,
        // IA-L1: bound the upstream call so a hung voice-capture never stalls the
        // request indefinitely. 150s (not the 15s convention) because transcription
        // is legitimately slow; a timeout surfaces as the 502 below (AbortError).
        signal: AbortSignal.timeout(150_000),
      })
    } catch (err) {
      logger.error({ err, url: VOICE_CAPTURE_URL }, '[voice-captures] upstream unreachable or timed out')
      return c.json({ error: 'voice-capture service unreachable', code: 'BAD_GATEWAY' }, 502)
    }

    const durationMs = Date.now() - t0
    const text = await response.text()
    logger.info(
      { upstreamStatus: response.status, durationMs, fileBytes: (file as File).size },
      '[voice-captures] proxied',
    )

    return new Response(text, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
    })
  })
}
