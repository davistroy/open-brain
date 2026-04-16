import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SlackMessenger } from '@open-brain/shared'

// ============================================================
// Fetch mock setup
// ============================================================

const originalFetch = globalThis.fetch

function mockFetch(response: { ok: boolean; json?: unknown; text?: string; status?: number }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(response.json ?? { ok: true }),
    text: vi.fn().mockResolvedValue(response.text ?? ''),
  })
}

// ============================================================
// Tests: SlackMessenger
// ============================================================

describe('SlackMessenger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.SLACK_BOT_TOKEN
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('isConfigured', () => {
    it('returns false when no token provided', () => {
      const messenger = new SlackMessenger()
      expect(messenger.isConfigured).toBe(false)
    })

    it('returns true when token provided via constructor', () => {
      const messenger = new SlackMessenger('xoxb-test-token')
      expect(messenger.isConfigured).toBe(true)
    })

    it('returns true when token provided via env var', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-env-token'
      const messenger = new SlackMessenger()
      expect(messenger.isConfigured).toBe(true)
    })

    it('returns false when token is empty string', () => {
      const messenger = new SlackMessenger('')
      expect(messenger.isConfigured).toBe(false)
    })
  })

  describe('sendMessage', () => {
    it('returns false when not configured', async () => {
      const messenger = new SlackMessenger()
      const result = await messenger.sendMessage({
        channel: 'C123',
        text: 'hello',
      })
      expect(result).toBe(false)
    })

    it('sends message with correct headers and body', async () => {
      const fetchMock = mockFetch({ ok: true, json: { ok: true } })
      globalThis.fetch = fetchMock

      const messenger = new SlackMessenger('xoxb-test-token')
      const result = await messenger.sendMessage({
        channel: 'D0AR39RNG4E',
        text: 'Morning brief text',
      })

      expect(result).toBe(true)
      expect(fetchMock).toHaveBeenCalledOnce()

      const [url, options] = fetchMock.mock.calls[0]
      expect(url).toBe('https://slack.com/api/chat.postMessage')
      expect(options.method).toBe('POST')
      expect(options.headers['Content-Type']).toBe('application/json; charset=utf-8')
      expect(options.headers.Authorization).toBe('Bearer xoxb-test-token')

      const body = JSON.parse(options.body)
      expect(body.channel).toBe('D0AR39RNG4E')
      expect(body.text).toBe('Morning brief text')
      expect(body.blocks).toBeUndefined()
    })

    it('includes blocks when provided', async () => {
      const fetchMock = mockFetch({ ok: true, json: { ok: true } })
      globalThis.fetch = fetchMock

      const messenger = new SlackMessenger('xoxb-test-token')
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'Test Header' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*Bold text*' } },
      ]

      const result = await messenger.sendMessage({
        channel: 'C123',
        text: 'fallback',
        blocks,
      })

      expect(result).toBe(true)
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.blocks).toHaveLength(2)
      expect(body.blocks[0].type).toBe('header')
    })

    it('returns false on HTTP error', async () => {
      const fetchMock = mockFetch({ ok: false, status: 500, text: 'Internal Server Error' })
      globalThis.fetch = fetchMock

      const messenger = new SlackMessenger('xoxb-test-token')
      const result = await messenger.sendMessage({
        channel: 'C123',
        text: 'hello',
      })

      expect(result).toBe(false)
    })

    it('returns false on Slack API logical error (ok: false)', async () => {
      const fetchMock = mockFetch({
        ok: true,
        json: { ok: false, error: 'channel_not_found' },
      })
      globalThis.fetch = fetchMock

      const messenger = new SlackMessenger('xoxb-test-token')
      const result = await messenger.sendMessage({
        channel: 'INVALID',
        text: 'hello',
      })

      expect(result).toBe(false)
    })

    it('returns false on network error (fetch throws)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

      const messenger = new SlackMessenger('xoxb-test-token')
      const result = await messenger.sendMessage({
        channel: 'C123',
        text: 'hello',
      })

      expect(result).toBe(false)
    })

    it('does not include blocks key when blocks array is empty', async () => {
      const fetchMock = mockFetch({ ok: true, json: { ok: true } })
      globalThis.fetch = fetchMock

      const messenger = new SlackMessenger('xoxb-test-token')
      await messenger.sendMessage({
        channel: 'C123',
        text: 'hello',
        blocks: [],
      })

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.blocks).toBeUndefined()
    })
  })
})
