import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PushoverService } from '../services/pushover.js'
import { processPushoverJob } from '../jobs/pushover.js'
import type { PushoverJobData } from '../jobs/pushover.js'

// ============================================================
// Mock fetch globally
// ============================================================

function makeFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue('{"status":1}'),
  })
}

function makeFetchError(status = 429) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(`{"status":0,"errors":["rate limit"]}`),
  })
}

// ============================================================
// PushoverService unit tests
// ============================================================

describe('PushoverService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PUSHOVER_APP_TOKEN
    delete process.env.PUSHOVER_USER_KEY
    delete process.env.PUSHOVER_TITLE_PREFIX
  })

  describe('isConfigured', () => {
    it('returns true when both credentials are provided via constructor', () => {
      const svc = new PushoverService('app-token', 'user-key')
      expect(svc.isConfigured).toBe(true)
    })

    it('returns true when credentials are read from env vars', () => {
      process.env.PUSHOVER_APP_TOKEN = 'env-token'
      process.env.PUSHOVER_USER_KEY = 'env-user'
      const svc = new PushoverService()
      expect(svc.isConfigured).toBe(true)
    })

    it('returns false when app token is missing', () => {
      const svc = new PushoverService(undefined, 'user-key')
      expect(svc.isConfigured).toBe(false)
    })

    it('returns false when user key is missing', () => {
      const svc = new PushoverService('app-token', undefined)
      expect(svc.isConfigured).toBe(false)
    })

    it('returns false when both credentials are missing', () => {
      const svc = new PushoverService()
      expect(svc.isConfigured).toBe(false)
    })
  })

  describe('send — not configured', () => {
    it('silently returns without calling fetch when not configured', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService()
      await svc.send({ title: 'Test', message: 'Hello' })

      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('send — happy path', () => {
    it('sends POST to Pushover API with correct URL and headers', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('test-token', 'test-user')
      await svc.send({ title: 'Open Brain', message: 'Brief ready', priority: 0 })

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.pushover.net/1/messages.json')
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    })

    it('includes token, user, title, message, and priority in request body', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'Test title', message: 'Test message', priority: 1 })

      const body: string = mockFetch.mock.calls[0][1].body
      const params = new URLSearchParams(body)
      expect(params.get('token')).toBe('tok')
      expect(params.get('user')).toBe('usr')
      // Titles carry the default 'Open Brain' identity prefix (see the
      // "title prefix / app identity" describe block for the full contract).
      expect(params.get('title')).toBe('Open Brain: Test title')
      expect(params.get('message')).toBe('Test message')
      expect(params.get('priority')).toBe('1')
    })

    it('defaults to priority -1 (low) when priority not specified', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'T', message: 'M' })

      const body: string = mockFetch.mock.calls[0][1].body
      const params = new URLSearchParams(body)
      expect(params.get('priority')).toBe('-1')
    })

    it('includes url and url_title when provided', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({
        title: 'T',
        message: 'M',
        url: 'https://brain.k4jda.net',
        url_title: 'Open Brain',
      })

      const body: string = mockFetch.mock.calls[0][1].body
      const params = new URLSearchParams(body)
      expect(params.get('url')).toBe('https://brain.k4jda.net')
      expect(params.get('url_title')).toBe('Open Brain')
    })

    it('includes retry and expire for emergency priority 2', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'Emergency', message: 'System down', priority: 2 })

      const body: string = mockFetch.mock.calls[0][1].body
      const params = new URLSearchParams(body)
      expect(params.get('priority')).toBe('2')
      expect(params.get('retry')).toBe('60')   // default
      expect(params.get('expire')).toBe('3600') // default
    })

    it('uses provided retry/expire for emergency priority', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'E', message: 'M', priority: 2, retry: 120, expire: 7200 })

      const body: string = mockFetch.mock.calls[0][1].body
      const params = new URLSearchParams(body)
      expect(params.get('retry')).toBe('120')
      expect(params.get('expire')).toBe('7200')
    })

    it('does not include retry/expire for non-emergency priorities', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'T', message: 'M', priority: 1, retry: 60, expire: 3600 })

      const body: string = mockFetch.mock.calls[0][1].body
      const params = new URLSearchParams(body)
      // retry and expire should NOT be set for priority 1
      expect(params.get('retry')).toBeNull()
      expect(params.get('expire')).toBeNull()
    })
  })

  describe('title prefix / app identity', () => {
    // Motivation (#312): the Pushover *application* banner ("From Voice Capture")
    // is registered in the console and cannot be set per message. Prefixing every
    // title with a stable product identity makes an infra alert unmistakable even
    // under the wrong banner. The prefix is idempotent so already-branded titles
    // are left alone.
    function sentTitle(mockFetch: ReturnType<typeof makeFetchOk>): string | null {
      const body: string = mockFetch.mock.calls[0][1].body
      return new URLSearchParams(body).get('title')
    }

    it("prepends the default 'Open Brain' identity to an unbranded title", async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'Daily Sweep', message: 'M' })

      expect(sentTitle(mockFetch)).toBe('Open Brain: Daily Sweep')
    })

    it("leaves a title already starting with 'Open Brain:' unchanged", async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'Open Brain: Pipeline Health Alert', message: 'M' })

      expect(sentTitle(mockFetch)).toBe('Open Brain: Pipeline Health Alert')
    })

    it("leaves the bare identity 'Open Brain' unchanged (no trailing separator added)", async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'Open Brain', message: 'M' })

      expect(sentTitle(mockFetch)).toBe('Open Brain')
    })

    it('idempotency is case-insensitive', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'open brain: already branded', message: 'M' })

      expect(sentTitle(mockFetch)).toBe('open brain: already branded')
    })

    it('honors an explicit titlePrefix from the config object', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService({ appToken: 'tok', userKey: 'usr', titlePrefix: 'Open Brain Infra' })
      await svc.send({ title: 'Backup Stale', message: 'M' })

      expect(sentTitle(mockFetch)).toBe('Open Brain Infra: Backup Stale')
    })

    it('falls back to PUSHOVER_TITLE_PREFIX env when no config prefix is set', async () => {
      process.env.PUSHOVER_TITLE_PREFIX = 'OB'
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await svc.send({ title: 'Cost Alert', message: 'M' })

      expect(sentTitle(mockFetch)).toBe('OB: Cost Alert')
    })

    it('an empty-string titlePrefix disables prefixing entirely', async () => {
      const mockFetch = makeFetchOk()
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService({ appToken: 'tok', userKey: 'usr', titlePrefix: '' })
      await svc.send({ title: 'Raw Title', message: 'M' })

      expect(sentTitle(mockFetch)).toBe('Raw Title')
    })
  })

  describe('send — HTTP errors', () => {
    it('throws on non-2xx Pushover API response', async () => {
      const mockFetch = makeFetchError(429)
      vi.stubGlobal('fetch', mockFetch)

      const svc = new PushoverService('tok', 'usr')
      await expect(svc.send({ title: 'T', message: 'M' })).rejects.toThrow('429')
    })

    it('throws on 500 server error', async () => {
      vi.stubGlobal('fetch', makeFetchError(500))

      const svc = new PushoverService('tok', 'usr')
      await expect(svc.send({ title: 'T', message: 'M' })).rejects.toThrow('500')
    })
  })
})

// ============================================================
// processPushoverJob unit tests
// ============================================================

describe('processPushoverJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates to PushoverService.send with correct options', async () => {
    const svc = new PushoverService('tok', 'usr')
    const sendSpy = vi.spyOn(svc, 'send').mockResolvedValue(undefined)

    const data: PushoverJobData = {
      title: 'Test notification',
      message: 'Pipeline complete',
      priority: 0,
    }

    await processPushoverJob(data, svc)

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test notification',
        message: 'Pipeline complete',
        priority: 0,
      }),
    )
  })

  it('passes url and url_title through to service', async () => {
    const svc = new PushoverService('tok', 'usr')
    const sendSpy = vi.spyOn(svc, 'send').mockResolvedValue(undefined)

    const data: PushoverJobData = {
      title: 'Brief ready',
      message: 'Your weekly brief is ready',
      priority: 0,
      url: 'https://brain.k4jda.net',
      url_title: 'View Brief',
    }

    await processPushoverJob(data, svc)

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://brain.k4jda.net',
        url_title: 'View Brief',
      }),
    )
  })

  it('throws when PushoverService.send throws (allowing BullMQ retry)', async () => {
    const svc = new PushoverService('tok', 'usr')
    vi.spyOn(svc, 'send').mockRejectedValue(new Error('Pushover API error 429'))

    await expect(
      processPushoverJob({ title: 'T', message: 'M' }, svc),
    ).rejects.toThrow('Pushover API error 429')
  })

  it('handles emergency priority job data with retry/expire', async () => {
    const svc = new PushoverService('tok', 'usr')
    const sendSpy = vi.spyOn(svc, 'send').mockResolvedValue(undefined)

    const data: PushoverJobData = {
      title: 'System Critical',
      message: 'Pipeline down — 0 jobs processed in 2 hours',
      priority: 2,
      retry: 60,
      expire: 3600,
    }

    await processPushoverJob(data, svc)

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 2,
        retry: 60,
        expire: 3600,
      }),
    )
  })
})
