import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/bolt'
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
  // Audio attachment routing
  // -------------------------------------------------------------------------

  describe('audio attachment routing', () => {
    it('sends audio-routing message when audio file is attached', async () => {
      const msg = {
        ...makeMessage(),
        files: [{ mimetype: 'audio/mp4', name: 'voice-memo.m4a' }],
      } as unknown as GenericMessageEvent

      await handleCapture(msg, say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Audio message received')
    })

    it('does not call captures_create for audio messages', async () => {
      const msg = {
        ...makeMessage(),
        files: [{ mimetype: 'audio/wav', name: 'recording.wav' }],
      } as unknown as GenericMessageEvent

      await handleCapture(msg, say, client)
      expect(client.captures_create).not.toHaveBeenCalled()
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
