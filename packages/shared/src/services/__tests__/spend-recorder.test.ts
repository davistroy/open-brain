import { describe, it, expect, vi } from 'vitest'
import { recordSpend } from '../spend-recorder.js'
import type { Database } from '../../db/index.js'

function makeDb(): { db: Database; inserts: Record<string, unknown>[] } {
  const inserts: Record<string, unknown>[] = []
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        inserts.push(v)
      }),
    })),
  } as unknown as Database
  return { db, inserts }
}

describe('recordSpend', () => {
  it('inserts an ai_audit_log row with the provided spend fields', async () => {
    const { db, inserts } = makeDb()
    await recordSpend(db, {
      taskType: 'embedding',
      model: 'text-embedding-3-large',
      clientUsed: 'litellm',
      costUsd: 0.0013,
      promptTokens: 100,
      totalTokens: 100,
      durationMs: 5,
    })
    expect(inserts).toHaveLength(1)
    const row = inserts[0]
    expect(row.task_type).toBe('embedding')
    expect(row.model).toBe('text-embedding-3-large')
    expect(row.client_used).toBe('litellm')
    expect(row.total_tokens).toBe(100)
    expect(row.cost_usd).toBe('0.0013') // numeric column → stringified
  })

  it('writes null cost_usd when costUsd is null', async () => {
    const { db, inserts } = makeDb()
    await recordSpend(db, { taskType: 't', model: 'm', clientUsed: 'openai', costUsd: null })
    expect(inserts[0].cost_usd).toBeNull()
  })

  it('swallows DB errors — never throws to the caller', async () => {
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(async () => { throw new Error('db down') }) })),
    } as unknown as Database
    await expect(
      recordSpend(db, { taskType: 't', model: 'm', clientUsed: 'openai', costUsd: 0 }),
    ).resolves.toBeUndefined()
  })
})
