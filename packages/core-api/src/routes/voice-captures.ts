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

    const upstreamForm = new FormData()
    for (const [key, value] of formData.entries()) {
      upstreamForm.append(key, value)
    }

    const t0 = Date.now()
    let response: Response
    try {
      response = await fetch(VOICE_CAPTURE_URL, {
        method: 'POST',
        headers: { 'X-Open-Brain-Caller': 'web-next-public' },
        body: upstreamForm,
      })
    } catch (err) {
      logger.error({ err, url: VOICE_CAPTURE_URL }, '[voice-captures] upstream unreachable')
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
