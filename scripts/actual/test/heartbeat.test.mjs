import { describe, it, expect, vi } from 'vitest'
import { postHeartbeat, reportOutcome } from '../lib/heartbeat.mjs'

describe('postHeartbeat', () => {
  it('posts to the actual heartbeat route with the caller header and a timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await postHeartbeat({ coreApiUrl: 'http://core.test:3000/', ok: true, meta: { n: 1 }, fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://core.test:3000/api/v1/internal/heartbeat/actual')
    expect(init.method).toBe('POST')
    expect(init.headers['X-Open-Brain-Caller']).toBe('actual-pipeline')
    expect(JSON.parse(init.body)).toEqual({ ok: true, meta: { n: 1 } })
    expect(init.signal).toBeDefined()
  })

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 })
    await expect(postHeartbeat({ coreApiUrl: 'http://x', ok: true, fetchImpl })).rejects.toThrow(/403/)
  })
})

describe('reportOutcome', () => {
  it('success posts ok:true', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const push = vi.fn().mockResolvedValue(undefined)
    await reportOutcome({ ok: true, postHeartbeat: post, sendPushover: push })
    expect(post).toHaveBeenCalledWith({ ok: true, errors: undefined, meta: undefined })
    expect(push).not.toHaveBeenCalled()
  })

  it('fatal error posts ok:false with the message', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const push = vi.fn()
    await reportOutcome({ ok: false, error: new Error('boom'), postHeartbeat: post, sendPushover: push })
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errors: ['boom'] }))
    expect(push).not.toHaveBeenCalled()
  })

  it('failed post on the fatal path sends exactly one priority-1 Pushover', async () => {
    const post = vi.fn().mockRejectedValue(new Error('down'))
    const push = vi.fn().mockResolvedValue(undefined)
    await reportOutcome({ ok: false, error: new Error('boom'), postHeartbeat: post, sendPushover: push })
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][2]).toBe(1)
    expect(push.mock.calls[0][1]).toContain('boom')
  })

  it('failed post on the success path sends no Pushover and does not throw', async () => {
    const post = vi.fn().mockRejectedValue(new Error('down'))
    const push = vi.fn()
    const logger = { warn: vi.fn() }
    await expect(reportOutcome({ ok: true, postHeartbeat: post, sendPushover: push, logger })).resolves.toBeUndefined()
    expect(push).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('a failing Pushover on the fatal path does not throw', async () => {
    const post = vi.fn().mockRejectedValue(new Error('down'))
    const push = vi.fn().mockRejectedValue(new Error('pushover down'))
    await expect(
      reportOutcome({ ok: false, error: 'x', postHeartbeat: post, sendPushover: push }),
    ).resolves.toBeUndefined()
  })
})
