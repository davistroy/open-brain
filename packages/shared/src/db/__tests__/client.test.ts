import { describe, it, expect, vi, beforeEach } from 'vitest'

const poolInstances: Array<{ opts: Record<string, unknown>; handlers: Record<string, (e: Error) => void> }> = []

vi.mock('pg', () => {
  const Pool = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    const inst = {
      opts,
      handlers: {} as Record<string, (e: Error) => void>,
      on(event: string, cb: (e: Error) => void) {
        inst.handlers[event] = cb
        return inst
      },
    }
    poolInstances.push(inst)
    return inst
  })
  return { Pool, default: { Pool } }
})

vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: vi.fn(() => ({})) }))

const loggerError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { createDb } from '../client.js'

describe('createDb', () => {
  beforeEach(() => {
    poolInstances.length = 0
    loggerError.mockClear()
  })

  it('logs an idle client error and does not throw', () => {
    createDb('postgres://x')
    const handler = poolInstances[0]!.handlers['error']
    expect(handler).toBeTypeOf('function')
    const err = new Error('terminating connection')
    expect(() => handler!(err)).not.toThrow()
    expect(loggerError).toHaveBeenCalledWith({ err }, '[db] idle client error')
  })

  it('passes statement_timeout to the Pool when statementTimeoutMs is set', () => {
    createDb('postgres://x', { statementTimeoutMs: 60000 })
    expect(poolInstances[0]!.opts.statement_timeout).toBe(60000)
  })

  it('has no statement_timeout key without the option', () => {
    createDb('postgres://x')
    expect(poolInstances[0]!.opts).not.toHaveProperty('statement_timeout')
    createDb('postgres://x', {})
    expect(poolInstances[1]!.opts).not.toHaveProperty('statement_timeout')
  })
})
