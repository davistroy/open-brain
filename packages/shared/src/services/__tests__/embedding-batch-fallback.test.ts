import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the OpenAI SDK before importing EmbeddingService (matches embedding-spend.test.ts pattern).
const mockCreate = vi.fn()
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({ embeddings: { create: mockCreate } })),
}))

const { EmbeddingService, EmbeddingUnavailableError } = await import('../embedding.js')
import type { ConfigService } from '../../config/loader.js'

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

function makeUnitVector(dimensions = 768): number[] {
  const vec = new Array(dimensions).fill(0)
  vec[0] = 1.0
  return vec
}

function checkUnitLength(vec: number[], tolerance = 1e-6): boolean {
  const sumOfSquares = vec.reduce((sum, v) => sum + v * v, 0)
  return Math.abs(sumOfSquares - 1.0) < tolerance
}

const tokenOverflowError = new Error(
  "This model's maximum context length is 8191 tokens, however you requested 9000 tokens.",
)

describe('EmbeddingService.embedBatch — per-chunk fallback (PE-M2 / 5.5)', () => {
  let service: InstanceType<typeof EmbeddingService>

  beforeEach(() => {
    mockCreate.mockReset()
    service = new EmbeddingService({ apiKey: 'k', configService: makeConfig() })
  })

  it('falls back to per-chunk embed() when the batch is rejected for token overflow, so other chunks still succeed', async () => {
    // 1st call: batch request rejected for token overflow (one oversized chunk
    // pushed the whole request over the limit).
    mockCreate.mockRejectedValueOnce(tokenOverflowError)
    // Fallback: one embed() call per input text, in order.
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: makeUnitVector(), index: 0 }] })
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: makeUnitVector(), index: 0 }] })

    const result = await service.embedBatch(['a normal-sized chunk', 'an oversized chunk'])

    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(768)
    expect(result[1]).toHaveLength(768)
    expect(checkUnitLength(result[0])).toBe(true)
    expect(checkUnitLength(result[1])).toBe(true)

    // 1 batch attempt + 2 per-chunk fallback calls
    expect(mockCreate).toHaveBeenCalledTimes(3)
    // First call was the batch attempt (array input)
    expect(mockCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ input: ['a normal-sized chunk', 'an oversized chunk'] }),
    )
    // Fallback calls use single-string input (the embed() path)
    expect(mockCreate.mock.calls[1][0]).toEqual(
      expect.objectContaining({ input: 'a normal-sized chunk' }),
    )
    expect(mockCreate.mock.calls[2][0]).toEqual(
      expect.objectContaining({ input: 'an oversized chunk' }),
    )
  })

  it('does NOT fall back for non-token-overflow batch failures — stays all-or-nothing', async () => {
    mockCreate.mockRejectedValueOnce(new Error('connection refused'))

    await expect(service.embedBatch(['a', 'b'])).rejects.toThrow(EmbeddingUnavailableError)
    // No fallback attempted — exactly one call (the failed batch attempt)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('does NOT fall back on an API-contract violation (result count mismatch)', async () => {
    // API returns only 1 embedding for 2 inputs — this is thrown as
    // EmbeddingUnavailableError inside the try, not a raw token-overflow error.
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: makeUnitVector(), index: 0 }] })

    await expect(service.embedBatch(['a', 'b'])).rejects.toThrow(EmbeddingUnavailableError)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('single-chunk batch still recovers via fallback on token overflow', async () => {
    mockCreate.mockRejectedValueOnce(tokenOverflowError)
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: makeUnitVector(), index: 0 }] })

    const result = await service.embedBatch(['one very large chunk'])

    expect(result).toHaveLength(1)
    expect(checkUnitLength(result[0])).toBe(true)
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })
})
