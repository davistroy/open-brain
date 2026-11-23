import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PushoverService } from '../pushover.js'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function sentParams(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams {
  const init = fetchMock.mock.calls[0][1] as RequestInit
  return new URLSearchParams(init.body as string)
}

describe('PushoverService', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const svc = () => new PushoverService({ appToken: 'tok', userKey: 'usr', onError: 'throw' })

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('length caps', () => {
    it('sends a short message unchanged', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1 }))
      await svc().send({ title: 'T', message: 'hello' })
      expect(sentParams(fetchMock).get('message')).toBe('hello')
    })

    it('sends a message of exactly 1024 characters unchanged', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1 }))
      const msg = 'a'.repeat(1024)
      await svc().send({ title: 'T', message: msg })
      expect(sentParams(fetchMock).get('message')).toBe(msg)
    })

    it('truncates a longer message to exactly 1024 chars ending with …(+N)', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1 }))
      const msg = 'b'.repeat(2000)
      await svc().send({ title: 'T', message: msg })
      const sent = sentParams(fetchMock).get('message')!
      expect(sent).toHaveLength(1024)
      const m = /…\(\+(\d+)\)$/.exec(sent)
      expect(m).not.toBeNull()
      const n = Number(m![1])
      const kept = sent.length - m![0].length
      expect(n).toBe(2000 - kept)
    })

    it('N counts removed characters across digit-count boundaries', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1 }))
      for (const len of [1025, 1040, 1100, 1200, 11_000]) {
        fetchMock.mockClear()
        await svc().send({ title: 'T', message: 'c'.repeat(len) })
        const sent = sentParams(fetchMock).get('message')!
        expect(sent).toHaveLength(1024)
        const m = /…\(\+(\d+)\)$/.exec(sent)!
        expect(Number(m[1])).toBe(len - (sent.length - m[0].length))
      }
    })

    it('truncates the prefixed title to 250 chars ending with …(+N)', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1 }))
      await svc().send({ title: 'x'.repeat(400), message: 'm' })
      const title = sentParams(fetchMock).get('title')!
      expect(title).toHaveLength(250)
      expect(title.startsWith('Open Brain: ')).toBe(true)
      const m = /…\(\+(\d+)\)$/.exec(title)!
      const full = 'Open Brain: ' + 'x'.repeat(400)
      expect(Number(m[1])).toBe(full.length - (title.length - m[0].length))
    })

    it('keeps the title prefix on a normal-length title', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1 }))
      await svc().send({ title: 'Backup Stale', message: 'm' })
      expect(sentParams(fetchMock).get('title')).toBe('Open Brain: Backup Stale')
    })
  })

  describe('receipt', () => {
    it('returns the receipt for priority 2', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1, request: 'r', receipt: 'rcpt123' }))
      const res = await svc().send({ title: 'T', message: 'm', priority: 2 })
      expect(res).toEqual({ receipt: 'rcpt123' })
    })

    it('returns undefined for priority below 2', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1, request: 'r' }))
      const res = await svc().send({ title: 'T', message: 'm', priority: 1 })
      expect(res).toBeUndefined()
    })

    it('returns undefined for priority 2 when the response carries no receipt or is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ status: 1 }))
      expect(await svc().send({ title: 'T', message: 'm', priority: 2 })).toBeUndefined()
      fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
      expect(await svc().send({ title: 'T', message: 'm', priority: 2 })).toBeUndefined()
    })

    it('returns undefined when not configured', async () => {
      const s = new PushoverService({ appToken: '', userKey: '' })
      expect(await s.send({ title: 'T', message: 'm', priority: 2 })).toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('getReceipt', () => {
    it('parses an acknowledged receipt', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ status: 1, acknowledged: 1, acknowledged_at: 1_700_000_000, expired: 0 }),
      )
      const r = await svc().getReceipt('rcpt123')
      expect(r).toEqual({
        acknowledged: true,
        acknowledgedAt: new Date(1_700_000_000 * 1000).toISOString(),
        expired: false,
      })
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toBe('https://api.pushover.net/1/receipts/rcpt123.json?token=tok')
    })

    it('parses an unacknowledged, expired receipt', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ status: 1, acknowledged: 0, acknowledged_at: 0, expired: 1 }),
      )
      expect(await svc().getReceipt('r')).toEqual({
        acknowledged: false,
        acknowledgedAt: null,
        expired: true,
      })
    })

    it('uses a 10 s timeout signal', async () => {
      fetchMock.mockResolvedValue(okResponse({ status: 1, acknowledged: 0, acknowledged_at: 0, expired: 0 }))
      await svc().getReceipt('r')
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('throws on an HTTP error so the caller can log and continue', async () => {
      fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))
      await expect(svc().getReceipt('r')).rejects.toThrow(/404/)
    })

    it('returns null when not configured', async () => {
      const s = new PushoverService({ appToken: '', userKey: '' })
      expect(await s.getReceipt('r')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
