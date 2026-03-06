import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { handleCapture } from '../handlers/capture.js'
import type { CoreApiClient } from '../lib/core-api-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSay(): SayFn {
  return vi.fn().mockResolvedValue({})
}

function makeMessage(overrides: Partial<GenericMessageEvent> = {}): GenericMessageEvent {
  return {
    type: 'message',
    subtype: undefined,
    channel: 'C1234567890',
    ts: '1234567890.000100',
    text: 'Decided to use tiered pricing for QSR segment.',
    user: 'U111222333',
    ...overrides,
  } as unknown as GenericMessageEvent
}

function makeCaptureResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-uuid-abc',
    content: 'Decided to use tiered pricing for QSR segment.',
    capture_type: 'decision',
    brain_view: 'work-internal',
    source: 'slack',
    pipeline_status: 'complete',
    tags: [],
    created_at: '2026-03-05T10:00:00Z',
    pre_extracted: {
      topics: ['pricing', 'QSR'],
      entities: [{ name: 'Alice Smith', type: 'person' }],
      sentiment: 'positive',
    },
    ...overrides,
  }
}

function makeClient(overrides: Partial<CoreApiClient> = {}): CoreApiClient {
  return {
    captures_create: vi.fn().mockResolvedValue(makeCaptureResult()),
    captures_get: vi.fn().mockResolvedValue(makeCaptureResult({ pipeline_status: 'complete' })),
    search_query: vi.fn(),
    synthesize_query: vi.fn(),
    stats_get: vi.fn(),
    ...overrides,
  } as unknown as CoreApiClient
}

/** Build a voice-capture API success response */
function makeVoiceCaptureResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    capture: { id: 'cap-voice-xyz', capture_type: 'observation', brain_view: 'personal' },
    transcription: { text: 'Need to follow up on the QSR contract by Friday.', language: 'en', duration: 4.2 },
    classification: { template: 'observation', confidence: 0.91 },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleCapture()', () => {
  let say: SayFn
  let client: CoreApiClient

  beforeEach(() => {
    say = makeSay()
    client = makeClient()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Happy path — successful capture
  // -------------------------------------------------------------------------

  describe('successful capture', () => {
    it('calls captures_create with content from message text', async () => {
      const msg = makeMessage({ text: 'Decided to use tiered pricing.' })
      await handleCapture(msg, say, client)
      expect(client.captures_create).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Decided to use tiered pricing.' }),
      )
    })

    it('sends source: slack', async () => {
      await handleCapture(makeMessage(), say, client)
      expect(client.captures_create).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'slack' }),
      )
    })

    it('includes slack_ts in source_metadata', async () => {
      const msg = makeMessage({ ts: '9999999999.000200' })
      await handleCapture(msg, say, client)
      expect(client.captures_create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            source_metadata: expect.objectContaining({ slack_ts: '9999999999.000200' }),
          }),
        }),
      )
    })

    it('includes channel in source_metadata', async () => {
      const msg = makeMessage({ channel: 'C0987654321' })
      await handleCapture(msg, say, client)
      expect(client.captures_create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            source_metadata: expect.objectContaining({ channel: 'C0987654321' }),
          }),
        }),
      )
    })

    it('includes user in source_metadata', async () => {
      const msg = makeMessage({ user: 'U999888777' })
      await handleCapture(msg, say, client)
      expect(client.captures_create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            source_metadata: expect.objectContaining({ user: 'U999888777' }),
          }),
        }),
      )
    })

    it('replies in thread after capture', async () => {
      const msg = makeMessage({ ts: '1111111111.000001' })
      // Fast-path: pipeline_status already complete
      ;(client.captures_get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeCaptureResult({ pipeline_status: 'complete' }),
      )
      vi.runAllTimersAsync()
      await handleCapture(msg, say, client)
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1111111111.000001' }),
      )
    })

    it('confirmation reply contains capture type', async () => {
      ;(client.captures_get as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeCaptureResult({ capture_type: 'decision', pipeline_status: 'complete' }),
      )
      vi.runAllTimersAsync()
      await handleCapture(makeMessage(), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('decision')
    })

    it('polls captures_get for pipeline completion', async () => {
      ;(client.captures_get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeCaptureResult({ pipeline_status: 'received' }))
        .mockResolvedValueOnce(makeCaptureResult({ pipeline_status: 'complete' }))

      // Resolve all timers so poll intervals don't hang
      vi.runAllTimersAsync()
      await handleCapture(makeMessage(), say, client)

      expect(client.captures_get).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Deduplication — 409 Conflict
  // -------------------------------------------------------------------------

  describe('duplicate handling', () => {
    it('replies "Already captured" on 409 Conflict', async () => {
      ;(client.captures_create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Core API captures.create failed 409: Capture already exists'),
      )
      await handleCapture(makeMessage(), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Already captured')
    })

    it('does not poll captures_get on 409', async () => {
      ;(client.captures_create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Core API captures.create failed 409: Conflict'),
      )
      await handleCapture(makeMessage(), say, client)
      expect(client.captures_get).not.toHaveBeenCalled()
    })

    it('still replies in thread on 409', async () => {
      const msg = makeMessage({ ts: '2222222222.000001' })
      ;(client.captures_create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Core API captures.create failed 409: Conflict'),
      )
      await handleCapture(msg, say, client)
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '2222222222.000001' }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Core API error (non-dedup)
  // -------------------------------------------------------------------------

  describe('Core API error', () => {
    it('replies with error message on 500 from Core API', async () => {
      ;(client.captures_create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Core API captures.create failed 500: Internal error'),
      )
      await handleCapture(makeMessage(), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })

    it('error reply includes context label', async () => {
      ;(client.captures_create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Core API captures.create failed 503: Service unavailable'),
      )
      await handleCapture(makeMessage(), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Capture failed')
    })
  })

  // -------------------------------------------------------------------------
  // Audio attachment routing (Phase 14.4)
  // -------------------------------------------------------------------------

  describe('audio attachment routing', () => {
    // Helper: build message with audio attachment
    function makeAudioMessage(overrides: Record<string, unknown> = {}): GenericMessageEvent {
      return {
        ...makeMessage(),
        files: [
          {
            mimetype: 'audio/mp4',
            name: 'voice-memo.m4a',
            url_private: 'https://files.slack.com/files-pri/T1/F1/voice-memo.m4a',
          },
        ],
        ...overrides,
      } as unknown as GenericMessageEvent
    }

    // Mocks for fetch (Slack download + voice-capture POST)
    function mockFetchSuccess(response = makeVoiceCaptureResponse()) {
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          // First call: Slack download
          new Response(new ArrayBuffer(1024), {
            status: 200,
            headers: { 'content-type': 'audio/mp4' },
          }),
        )
        .mockResolvedValueOnce(
          // Second call: voice-capture POST
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
    }

    it('does not call captures_create for audio messages', async () => {
      mockFetchSuccess()
      const msg = makeAudioMessage()
      await handleCapture(msg, say, client, 'xoxb-test-token', 'http://voice-capture:3001')
      expect(client.captures_create).not.toHaveBeenCalled()
    })

    it('sends acknowledgement reply before transcribing', async () => {
      mockFetchSuccess()
      const msg = makeAudioMessage({ ts: '5555555555.000001' })
      await handleCapture(msg, say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      // First say() call should be the ack
      const firstCall = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string; thread_ts: string }
      expect(firstCall.text).toContain('Transcribing')
      expect(firstCall.thread_ts).toBe('5555555555.000001')
    })

    it('replies in thread with transcription result', async () => {
      mockFetchSuccess()
      const msg = makeAudioMessage({ ts: '6666666666.000001' })
      await handleCapture(msg, say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      // Second say() call should contain transcription
      const secondCall = (say as ReturnType<typeof vi.fn>).mock.calls[1][0] as { text: string; thread_ts: string }
      expect(secondCall.text).toContain('Need to follow up on the QSR contract by Friday.')
      expect(secondCall.thread_ts).toBe('6666666666.000001')
    })

    it('reply includes capture type from classification', async () => {
      mockFetchSuccess(makeVoiceCaptureResponse({
        classification: { template: 'decision', confidence: 0.95 },
      }))
      await handleCapture(makeAudioMessage(), say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      const secondCall = (say as ReturnType<typeof vi.fn>).mock.calls[1][0] as { text: string }
      expect(secondCall.text).toContain('decision')
    })

    it('downloads audio from Slack with Authorization header', async () => {
      const fetchSpy = mockFetchSuccess()
      const msg = makeAudioMessage()
      await handleCapture(msg, say, client, 'xoxb-test-bot-token', 'http://voice-capture:3001')

      // First fetch call is the Slack download
      const [downloadUrl, downloadInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(downloadUrl).toBe('https://files.slack.com/files-pri/T1/F1/voice-memo.m4a')
      const authHeader = (downloadInit.headers as Record<string, string>)['Authorization']
      expect(authHeader).toBe('Bearer xoxb-test-bot-token')
    })

    it('POSTs to voice-capture /api/capture endpoint', async () => {
      const fetchSpy = mockFetchSuccess()
      await handleCapture(makeAudioMessage(), say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      const [vcUrl] = fetchSpy.mock.calls[1] as [string, RequestInit]
      expect(vcUrl).toBe('http://voice-capture:3001/api/capture')
    })

    it('does not route non-audio file attachments to voice handler', async () => {
      const msg = {
        ...makeMessage(),
        files: [{ mimetype: 'image/png', name: 'screenshot.png' }],
      } as unknown as GenericMessageEvent

      await handleCapture(msg, say, client)
      // Non-audio → should still call captures_create
      expect(client.captures_create).toHaveBeenCalled()
    })

    it('reports error in thread if SLACK_BOT_TOKEN is not configured', async () => {
      // No token, no env var
      delete process.env.SLACK_BOT_TOKEN
      const msg = makeAudioMessage({ ts: '7777777777.000001' })
      await handleCapture(msg, say, client, undefined, 'http://voice-capture:3001')

      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string; thread_ts: string }
      expect(call.text).toContain(':warning:')
      expect(call.text).toContain('SLACK_BOT_TOKEN')
      expect(call.thread_ts).toBe('7777777777.000001')
    })

    it('reports error in thread if VOICE_CAPTURE_URL is not configured', async () => {
      delete process.env.VOICE_CAPTURE_URL
      const msg = makeAudioMessage({ ts: '8888888888.000001' })
      await handleCapture(msg, say, client, 'xoxb-test-token', undefined)

      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string; thread_ts: string }
      expect(call.text).toContain(':warning:')
      expect(call.text).toContain('VOICE_CAPTURE_URL')
      expect(call.thread_ts).toBe('8888888888.000001')
    })

    it('reports error in thread if Slack download fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      )
      const msg = makeAudioMessage({ ts: '9999999999.000001' })
      await handleCapture(msg, say, client, 'xoxb-bad-token', 'http://voice-capture:3001')

      // First say() = ack, second = error
      const errorCall = (say as ReturnType<typeof vi.fn>).mock.calls[1][0] as { text: string }
      expect(errorCall.text).toContain(':warning:')
      expect(errorCall.text).toContain('Voice capture failed')
    })

    it('reports error in thread if voice-capture service returns error', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          // Slack download succeeds
          new Response(new ArrayBuffer(512), { status: 200 }),
        )
        .mockResolvedValueOnce(
          // Voice-capture returns error
          new Response(JSON.stringify({ error: 'Transcription timed out', code: 'TRANSCRIPTION_ERROR' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          }),
        )

      const msg = makeAudioMessage({ ts: '1010101010.000001' })
      await handleCapture(msg, say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      const errorCall = (say as ReturnType<typeof vi.fn>).mock.calls[1][0] as { text: string }
      expect(errorCall.text).toContain(':warning:')
      expect(errorCall.text).toContain('Voice capture failed')
    })

    it('reports error if url_private is missing on audio file', async () => {
      const msg = {
        ...makeMessage({ ts: '1212121212.000001' }),
        files: [{ mimetype: 'audio/mp4', name: 'voice.m4a' }],  // no url_private
      } as unknown as GenericMessageEvent

      await handleCapture(msg, say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
      expect(call.text).toContain('url_private')
    })

    it('sends slack_ts as form field to voice-capture', async () => {
      const fetchSpy = mockFetchSuccess()
      const msg = makeAudioMessage({ ts: '5432198760.000001' })
      await handleCapture(msg, say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      // Second fetch call is the voice-capture POST — body is FormData
      const [, vcInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
      const formData = vcInit.body as FormData
      expect(formData.get('slack_ts')).toBe('5432198760.000001')
    })

    it('sends device=slack to voice-capture', async () => {
      const fetchSpy = mockFetchSuccess()
      await handleCapture(makeAudioMessage(), say, client, 'xoxb-test-token', 'http://voice-capture:3001')

      const [, vcInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
      const formData = vcInit.body as FormData
      expect(formData.get('device')).toBe('slack')
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('skips messages with empty text', async () => {
      const msg = makeMessage({ text: '' })
      await handleCapture(msg, say, client)
      expect(client.captures_create).not.toHaveBeenCalled()
      expect(say).not.toHaveBeenCalled()
    })

    it('skips messages with undefined text', async () => {
      const msg = makeMessage({ text: undefined as unknown as string })
      await handleCapture(msg, say, client)
      expect(client.captures_create).not.toHaveBeenCalled()
    })

    it('trims whitespace from message text before posting', async () => {
      const msg = makeMessage({ text: '  Decided on flat-rate pricing.  ' })
      await handleCapture(msg, say, client)
      expect(client.captures_create).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Decided on flat-rate pricing.' }),
      )
    })
  })
})
