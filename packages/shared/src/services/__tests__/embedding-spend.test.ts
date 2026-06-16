import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the OpenAI SDK before importing EmbeddingService.
const mockCreate = vi.fn()
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({ embeddings: { create: mockCreate } })),
}))

const { EmbeddingService } = await import('../embedding.js')
import type { ConfigService } from '../../config/loader.js'
import type { Database } from '../../db/index.js'

function makeConfig(): ConfigService {
  return {
    get: () => ({
      models: {
        embedding: {
          model: 'text-embedding-3-large',
          client: 'litellm',
          cost_per_1k_input: 0.00013,
          cost_per_1k_output: 0,
        },
      },
    }),
  } as unknown as ConfigService
}

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

const okResponse = { data: [{ embedding: new Array(768).fill(0.1) }], usage: { total_tokens: 1000 } }

describe('EmbeddingService spend recording (INT-M2)', () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it('records embedding spend in ai_audit_log when a db is provided', async () => {
    mockCreate.mockResolvedValue(okResponse)
    const { db, inserts } = makeDb()
    const svc = new EmbeddingService({ apiKey: 'k', configService: makeConfig(), db })

    const vec = await svc.embed('hello world')

    expect(vec).toHaveLength(768)
    expect(inserts).toHaveLength(1)
    const row = inserts[0]
    expect(row.task_type).toBe('embedding')
    expect(row.client_used).toBe('litellm')
    expect(row.model).toBe('text-embedding-3-large')
    expect(row.total_tokens).toBe(1000)
    expect(row.prompt_tokens).toBe(1000) // embeddings are input-only
    expect(row.cost_usd).toBe('0.00013') // 1000 * 0.00013 / 1000
  })

  it('does NOT record spend when no db is provided (back-compat)', async () => {
    mockCreate.mockResolvedValue(okResponse)
    const svc = new EmbeddingService({ apiKey: 'k', configService: makeConfig() })

    const vec = await svc.embed('hello world')

    expect(vec).toHaveLength(768) // still works, just no audit row
  })

  it('records a single batch row for embedBatch', async () => {
    mockCreate.mockResolvedValue({
      data: [
        { index: 0, embedding: new Array(768).fill(0.1) },
        { index: 1, embedding: new Array(768).fill(0.2) },
      ],
      usage: { total_tokens: 2000 },
    })
    const { db, inserts } = makeDb()
    const svc = new EmbeddingService({ apiKey: 'k', configService: makeConfig(), db })

    const vecs = await svc.embedBatch(['a', 'b'])

    expect(vecs).toHaveLength(2)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].total_tokens).toBe(2000)
    expect(inserts[0].cost_usd).toBe('0.00026') // 2000 * 0.00013 / 1000
  })
})
