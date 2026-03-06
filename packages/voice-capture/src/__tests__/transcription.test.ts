import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TranscriptionService } from '../services/transcription.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('TranscriptionService', () => {
  let service: TranscriptionService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new TranscriptionService('http://faster-whisper-test:10300')
  })

  describe('transcribe', () => {
    it('returns transcript text, language, duration, and segments on success', async () => {
      const responseData = {
        text: 'This is a test transcription.',
        language: 'en',
        duration: 4.2,
        segments: [
          { start: 0, end: 2.1, text: 'This is a test' },
          { start: 2.1, end: 4.2, text: ' transcription.' },
        ],
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      })

      const buffer = new ArrayBuffer(1024)
      const result = await service.transcribe(buffer, 'test.m4a')

      expect(result.text).toBe('This is a test transcription.')
      expect(result.language).toBe('en')
      expect(result.duration).toBe(4.2)
      expect(result.segments).toHaveLength(2)
    })

    it('trims whitespace from transcript text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '  hello world  ', language: 'en', duration: 1.0, segments: [] }),
      })

      const result = await service.transcribe(new ArrayBuffer(512), 'clip.wav')
      expect(result.text).toBe('hello world')
    })

    it('defaults language to en and duration to 0 when missing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'something' }),
      })

      const result = await service.transcribe(new ArrayBuffer(256), 'clip.mp3')
      expect(result.language).toBe('en')
      expect(result.duration).toBe(0)
      expect(result.segments).toEqual([])
    })

    it('throws when faster-whisper returns non-ok status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      })

      const buffer = new ArrayBuffer(256)
      await expect(service.transcribe(buffer, 'audio.m4a')).rejects.toThrow('faster-whisper returned HTTP 503')
    })

    it('throws when fetch itself fails (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

      await expect(service.transcribe(new ArrayBuffer(256), 'audio.ogg')).rejects.toThrow('ECONNREFUSED')
    })

    it('sends correct Content-Type for .m4a files', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'ok', language: 'en', duration: 1 }),
      })

      await service.transcribe(new ArrayBuffer(128), 'memo.m4a')

      const callArgs = mockFetch.mock.calls[0]
      const formData = callArgs[1].body as FormData
      const file = formData.get('file') as Blob
      expect(file.type).toBe('audio/mp4')
    })

    it('sends correct Content-Type for .wav files', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'ok', language: 'en', duration: 1 }),
      })

      await service.transcribe(new ArrayBuffer(128), 'clip.wav')

      const callArgs = mockFetch.mock.calls[0]
      const formData = callArgs[1].body as FormData
      const file = formData.get('file') as Blob
      expect(file.type).toBe('audio/wav')
    })

    it('sends verbose_json response format to faster-whisper', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'ok', language: 'en', duration: 1 }),
      })

      await service.transcribe(new ArrayBuffer(128), 'clip.mp3')

      const callArgs = mockFetch.mock.calls[0]
      const formData = callArgs[1].body as FormData
      expect(formData.get('response_format')).toBe('verbose_json')
    })
  })
})
