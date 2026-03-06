import pino from 'pino'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const CORE_API_URL = process.env.CORE_API_URL ?? 'http://core-api:3000'
const MAX_ATTEMPTS = 3
// Backoff: 1s, 2s, 4s
const BACKOFF_BASE_MS = 1_000
const REQUEST_TIMEOUT_MS = 15_000

export interface IngestPayload {
  content: string
  capture_type: string
  brain_view: string
  source: 'voice'
  tags: string[]
  metadata: {
    source_metadata: {
      device: string
      duration_seconds: number
      original_filename: string
      language: string
    }
    pre_extracted: {
      template: string
      confidence: number
      fields: Array<{ name: string; value: string }>
      transcript_raw: string
    }
  }
}

export interface IngestResult {
  id: string
  [key: string]: unknown
}

/**
 * IngestService posts a capture to Core API /api/v1/captures with retry.
 * Retries up to 3 times with exponential backoff (1s, 2s, 4s) on 5xx or
 * network errors. 4xx errors are not retried — they indicate a bad payload.
 * Throws if all attempts fail.
 */
export class IngestService {
  private coreApiUrl: string

  constructor(coreApiUrl: string = CORE_API_URL) {
    this.coreApiUrl = coreApiUrl
  }

  async ingest(payload: IngestPayload): Promise<IngestResult> {
    const url = `${this.coreApiUrl}/api/v1/captures`
    let lastError: string | undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })

        if (res.ok) {
          const created = await res.json() as IngestResult
          logger.info(
            { captureId: created.id, template: payload.capture_type, attempt },
            'Capture created in Core API',
          )
          return created
        }

        const errorBody = await res.text().catch(() => '')
        lastError = `Core API returned HTTP ${res.status}: ${errorBody}`

        // 4xx — bad payload, not a transient error; do not retry
        if (res.status >= 400 && res.status < 500) {
          logger.error({ status: res.status, errorBody }, 'Core API rejected capture (4xx) — not retrying')
          throw new Error(lastError)
        }

        logger.warn({ attempt, status: res.status, errorBody }, 'Core API error — will retry')
      } catch (err) {
        // Re-throw 4xx errors immediately (already thrown above with message)
        if (err instanceof Error && err.message.startsWith('Core API returned HTTP 4')) {
          throw err
        }
        lastError = err instanceof Error ? err.message : String(err)
        logger.warn({ attempt, err }, 'Core API request failed — will retry')
      }

      if (attempt < MAX_ATTEMPTS) {
        const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1)
        logger.info({ delayMs, nextAttempt: attempt + 1 }, 'Backing off before retry')
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }

    throw new Error(`Failed to ingest capture after ${MAX_ATTEMPTS} attempts: ${lastError}`)
  }
}
