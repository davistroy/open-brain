import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IngestService, type IngestPayload } from '../services/ingest.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock setTimeout to avoid actual delays in backoff tests
vi.stubGlobal('setTimeout', (fn: () => void, _ms: number) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout> })

const SAMPLE_PAYLOAD: IngestPayload = {
  content: 'This is a voice memo about a project idea.',
  capture_type: 'idea',
  brain_view: 'personal',
  source: 'voice',
  tags: ['voice'],
  metadata: {
    source_metadata: {
      device: 'apple_watch',
      duration_seconds: 12.3,
      original_filename: 'memo.m4a',
      language: 'en',
    },
    pre_extracted: {
      template: 'idea',
      confidence: 0.92,
      fields: [
        { name: 'summary', value: 'Project idea about AI knowledge base' },
        { name: 'topics', value: 'AI, knowledge management, automation' },
      ],
      transcript_raw: 'This is a voice memo about a project idea.',
    },
  },
}

const CREATED_RESPONSE = {
  id: 'capture-abc-123',
  content: SAMPLE_PAYLOAD.content,
  source: 'voice',
  created_at: '2026-03-05T12:00:00.000Z',
}

describe('IngestService', () => {
  let service: IngestService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new IngestService('http://core-api-test:3000')
  })

  describe('ingest — success path', () => {
    it('returns created capture on first successful attempt', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CREATED_RESPONSE,
      })

      const result = await service.ingest(SAMPLE_PAYLOAD)

      expect(result.id).toBe('capture-abc-123')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('POSTs to /api/v1/captures with correct URL and headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CREATED_RESPONSE,
      })

      await service.ingest(SAMPLE_PAYLOAD)

      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('http://core-api-test:3000/api/v1/captures')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Content-Type']).toBe('application/json')
    })

    it('serializes payload correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CREATED_RESPONSE,
      })

      await service.ingest(SAMPLE_PAYLOAD)

      const [, opts] = mockFetch.mock.calls[0]
      const body = JSON.parse(opts.body as string) as IngestPayload
      expect(body.content).toBe(SAMPLE_PAYLOAD.content)
      expect(body.capture_type).toBe('idea')
      expect(body.source).toBe('voice')
      expect(body.tags).toEqual(['voice'])
      expect(body.metadata.pre_extracted.template).toBe('idea')
      expect(body.metadata.pre_extracted.confidence).toBe(0.92)
    })

    it('preserves pre_extracted classification metadata in payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CREATED_RESPONSE,
      })

      await service.ingest(SAMPLE_PAYLOAD)

      const [, opts] = mockFetch.mock.calls[0]
      const body = JSON.parse(opts.body as string) as IngestPayload
      expect(body.metadata.pre_extracted.fields).toHaveLength(2)
      expect(body.metadata.pre_extracted.transcript_raw).toBe(SAMPLE_PAYLOAD.content)
    })
  })

  describe('ingest — retry logic', () => {
    it('retries on 5xx and succeeds on second attempt', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'Service Unavailable' })
        .mockResolvedValueOnce({ ok: true, json: async () => CREATED_RESPONSE })

      const result = await service.ingest(SAMPLE_PAYLOAD)

      expect(result.id).toBe('capture-abc-123')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries on 5xx and succeeds on third attempt', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Server Error' })
        .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'Bad Gateway' })
        .mockResolvedValueOnce({ ok: true, json: async () => CREATED_RESPONSE })

      const result = await service.ingest(SAMPLE_PAYLOAD)

      expect(result.id).toBe('capture-abc-123')
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('throws after 3 failed attempts', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'Unavailable' })
        .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'Unavailable' })
        .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'Unavailable' })

      await expect(service.ingest(SAMPLE_PAYLOAD)).rejects.toThrow(
        'Failed to ingest capture after 3 attempts',
      )
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('retries on network error (fetch throws)', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ ok: true, json: async () => CREATED_RESPONSE })

      const result = await service.ingest(SAMPLE_PAYLOAD)

      expect(result.id).toBe('capture-abc-123')
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('throws after all network error attempts', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))

      await expect(service.ingest(SAMPLE_PAYLOAD)).rejects.toThrow(
        'Failed to ingest capture after 3 attempts',
      )
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })

  describe('ingest — 4xx errors (not retried)', () => {
    it('throws immediately on 400 Bad Request without retrying', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request: missing content',
      })

      await expect(service.ingest(SAMPLE_PAYLOAD)).rejects.toThrow('Core API returned HTTP 400')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('throws immediately on 422 Unprocessable Entity without retrying', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'Unprocessable Entity',
      })

      await expect(service.ingest(SAMPLE_PAYLOAD)).rejects.toThrow('Core API returned HTTP 422')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })
})
