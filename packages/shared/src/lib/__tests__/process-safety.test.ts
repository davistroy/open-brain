import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { attachErrorListeners, installUnhandledRejectionHandler } from '../process-safety.js'

function makeLog() {
  return { error: vi.fn(), fatal: vi.fn() }
}

class FakeEmitter extends EventEmitter {
  constructor(public name?: string) {
    super()
  }
}

describe('attachErrorListeners', () => {
  it('logs one error line naming the queue', () => {
    const log = makeLog()
    const q = new FakeEmitter('capture-pipeline')
    attachErrorListeners([q], log)
    const err = new Error('ECONNREFUSED')
    q.emit('error', err)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith({ err, queue: 'capture-pipeline' }, 'bullmq error')
  })

  it('attaching the same emitter twice registers one listener', () => {
    const log = makeLog()
    const q = new FakeEmitter('q')
    attachErrorListeners([q], log)
    attachErrorListeners([q, q], log)
    expect(q.listenerCount('error')).toBe(1)
    q.emit('error', new Error('x'))
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('handles emitters without a name', () => {
    const log = makeLog()
    const q = new FakeEmitter()
    attachErrorListeners([q], log)
    q.emit('error', new Error('x'))
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls[0][0].queue).toBeUndefined()
  })
})

describe('installUnhandledRejectionHandler', () => {
  it('logs once at fatal and calls exit(1)', () => {
    const log = makeLog()
    const exit = vi.fn()
    const before = process.listeners('unhandledRejection')
    installUnhandledRejectionHandler(log, exit as unknown as (code: number) => never)
    const added = process.listeners('unhandledRejection').filter(l => !before.includes(l))
    try {
      expect(added).toHaveLength(1)
      const reason = new Error('boom')
      ;(added[0] as (r: unknown) => void)(reason)
      expect(log.fatal).toHaveBeenCalledTimes(1)
      expect(log.fatal.mock.calls[0][0]).toEqual({ err: reason })
      expect(exit).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      for (const l of added) process.removeListener('unhandledRejection', l as never)
    }
  })
})
