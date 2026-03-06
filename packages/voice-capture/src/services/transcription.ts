import pino from 'pino'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const WHISPER_URL = process.env.WHISPER_URL ?? 'http://faster-whisper:10300'
const TRANSCRIPTION_TIMEOUT_MS = 120_000 // 2 minutes — large-v3 CPU can be slow

export interface TranscriptionResult {
  text: string
  language: string
  duration: number
  segments: Array<{
    start: number
    end: number
    text: string
  }>
}

/**
 * TranscriptionService sends audio files to the faster-whisper HTTP server
 * using the OpenAI-compatible /v1/audio/transcriptions endpoint.
 * Returns transcript text, detected language, duration, and segments.
 */
export class TranscriptionService {
  private whisperUrl: string

  constructor(whisperUrl: string = WHISPER_URL) {
    this.whisperUrl = whisperUrl
  }

  async transcribe(audioBuffer: ArrayBuffer, filename: string): Promise<TranscriptionResult> {
    const url = `${this.whisperUrl}/v1/audio/transcriptions`

    logger.info({ filename, whisperUrl: this.whisperUrl }, 'Sending audio to faster-whisper')

    const formData = new FormData()
    const blob = new Blob([audioBuffer], { type: this.getMimeType(filename) })
    formData.append('file', blob, filename)
    formData.append('model', 'whisper-1') // faster-whisper accepts any model name via OpenAI API
    formData.append('response_format', 'verbose_json')

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      logger.error({ status: response.status, errorText, filename }, 'faster-whisper transcription failed')
      throw new Error(`faster-whisper returned HTTP ${response.status}: ${errorText}`)
    }

    const data = await response.json() as {
      text: string
      language?: string
      duration?: number
      segments?: Array<{ start: number; end: number; text: string }>
    }

    const result: TranscriptionResult = {
      text: data.text?.trim() ?? '',
      language: data.language ?? 'en',
      duration: data.duration ?? 0,
      segments: data.segments ?? [],
    }

    logger.info(
      { filename, language: result.language, duration: result.duration, textLength: result.text.length },
      'Transcription complete',
    )

    return result
  }

  private getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase()
    switch (ext) {
      case 'm4a': return 'audio/mp4'
      case 'wav': return 'audio/wav'
      case 'mp3': return 'audio/mpeg'
      case 'ogg': return 'audio/ogg'
      default: return 'application/octet-stream'
    }
  }
}
