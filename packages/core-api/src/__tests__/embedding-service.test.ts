import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmbeddingService, EmbeddingUnavailableError } from '../services/embedding.js'

// ---------------------------------------------------------------------------
// Mock the OpenAI client constructor so no real HTTP calls are made.
// We mock the entire 'openai' module and intercept the embeddings.create call.
// ---------------------------------------------------------------------------

const mockEmbeddingsCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: {
        create: mockEmbeddingsCreate,
      },
    })),
  }
})

// ---------------------------------------------------------------------------
// Helper: build a mock ConfigService
// ---------------------------------------------------------------------------

function makeMockConfigService(modelAlias = 'jetson-embeddings', litellmUrl = 'https://llm.k4jda.net') {
  return {
    get: vi.fn().mockReturnValue({
      models: { embedding: modelAlias },
      litellm_url: litellmUrl,
    }),
    getBrainViews: vi.fn(),
    load: vi.fn(),
    reload: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Helper: build a unit-normalized 768-dimensional vector
// ---------------------------------------------------------------------------

function makeUnitVector(dimensions = 768): number[] {
  // Create a vector with first element 1.0, rest 0.0 — already unit length
  const vec = new Array(dimensions).fill(0)
  vec[0] = 1.0
  return vec
}

// Helper to build a raw (non-normalized) vector that the mock API returns.
// We use a simple vector [2, 0, 0, ...] — after normalization → [1, 0, 0, ...]
function makeRawVector(dimensions = 768): number[] {
  const vec = new Array(dimensions).fill(0)
  vec[0] = 2.0 // magnitude = 2, so normalized[0] = 1.0
  return vec
}

function checkUnitLength(vec: number[], tolerance = 1e-6): boolean {
  const sumOfSquares = vec.reduce((sum, v) => sum + v * v, 0)
  return Math.abs(sumOfSquares - 1.0) < tolerance
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmbeddingService', () => {
  let service: EmbeddingService
  let configService: ReturnType<typeof makeMockConfigService>

  beforeEach(() => {
    vi.clearAllMocks()
    configService = makeMockConfigService()
    service = new EmbeddingService('https://llm.k4jda.net', 'test-api-key', configService as any)
  })

  // -------------------------------------------------------------------------
  // embed()
  // -------------------------------------------------------------------------

  describe('embed()', () => {
    it('returns a number[] of length 768', async () => {
      const rawVec = makeRawVector()
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: rawVec, index: 0 }],
      })

      const result = await service.embed('test query')

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(768)
    })

    it('returns a unit-normalized vector (sum of squares ≈ 1.0)', async () => {
      const rawVec = makeRawVector()
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: rawVec, index: 0 }],
      })

      const result = await service.embed('normalization test')

      expect(checkUnitLength(result)).toBe(true)
    })

    it('normalizes an already-unit-length vector correctly', async () => {
      const unitVec = makeUnitVector()
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: unitVec, index: 0 }],
      })

      const result = await service.embed('already normalized')

      expect(checkUnitLength(result)).toBe(true)
      expect(result[0]).toBeCloseTo(1.0)
    })

    it('throws EmbeddingUnavailableError when API call fails', async () => {
      mockEmbeddingsCreate.mockRejectedValueOnce(new Error('connection refused'))

      await expect(service.embed('failing query')).rejects.toThrow(EmbeddingUnavailableError)
    })

    it('throws EmbeddingUnavailableError with descriptive message on failure', async () => {
      mockEmbeddingsCreate.mockRejectedValueOnce(new Error('timeout after 30000ms'))

      await expect(service.embed('timeout query')).rejects.toThrow('timeout after 30000ms')
    })

    it('throws EmbeddingUnavailableError when API returns wrong dimension count', async () => {
      // API returns 512-dim instead of 768
      const wrongDimVec = new Array(512).fill(0.1)
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: wrongDimVec, index: 0 }],
      })

      await expect(service.embed('dimension mismatch')).rejects.toThrow(EmbeddingUnavailableError)
    })

    it('throws EmbeddingUnavailableError when API returns empty data array', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({ data: [] })

      await expect(service.embed('empty response')).rejects.toThrow(EmbeddingUnavailableError)
    })

    it('calls the OpenAI embeddings API with the correct model alias from config', async () => {
      const rawVec = makeRawVector()
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: rawVec, index: 0 }],
      })

      await service.embed('model alias test')

      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'jetson-embeddings',
          input: 'model alias test',
        }),
      )
    })

    it('returns all-zero values normalized to zero vector (no divide by zero crash)', async () => {
      const zeroVec = new Array(768).fill(0)
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: zeroVec, index: 0 }],
      })

      // Should not throw; normalizeVector returns the zero vector as-is when magnitude = 0
      const result = await service.embed('zero vector input')
      expect(result).toHaveLength(768)
      expect(result.every(v => v === 0)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // embedBatch()
  // -------------------------------------------------------------------------

  describe('embedBatch()', () => {
    it('returns an empty array for empty input without calling the API', async () => {
      const result = await service.embedBatch([])

      expect(result).toEqual([])
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled()
    })

    it('returns an array of unit-normalized 768-dimensional vectors', async () => {
      const rawVec1 = makeRawVector()
      const rawVec2 = makeRawVector()
      rawVec2[1] = 2.0 // make it different

      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [
          { embedding: rawVec1, index: 0 },
          { embedding: rawVec2, index: 1 },
        ],
      })

      const result = await service.embedBatch(['text one', 'text two'])

      expect(result).toHaveLength(2)
      expect(result[0]).toHaveLength(768)
      expect(result[1]).toHaveLength(768)
      expect(checkUnitLength(result[0])).toBe(true)
      expect(checkUnitLength(result[1])).toBe(true)
    })

    it('returns results sorted by index regardless of API response order', async () => {
      const vec0 = makeRawVector()
      const vec1 = makeRawVector()
      vec1[0] = 0
      vec1[1] = 2.0 // points in different direction than vec0

      // API returns them in reverse order (index 1 first, index 0 second)
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [
          { embedding: vec1, index: 1 },
          { embedding: vec0, index: 0 },
        ],
      })

      const result = await service.embedBatch(['first text', 'second text'])

      // result[0] should correspond to index 0 (vec0), result[1] to index 1 (vec1)
      expect(result[0][0]).toBeCloseTo(1.0) // vec0 normalized: [1, 0, ...]
      expect(result[1][0]).toBeCloseTo(0.0) // vec1 normalized: [0, 1, ...]
      expect(result[1][1]).toBeCloseTo(1.0)
    })

    it('throws EmbeddingUnavailableError on API failure', async () => {
      mockEmbeddingsCreate.mockRejectedValueOnce(new Error('LiteLLM upstream error'))

      await expect(service.embedBatch(['text a', 'text b'])).rejects.toThrow(EmbeddingUnavailableError)
    })

    it('throws EmbeddingUnavailableError when returned count does not match input count', async () => {
      const rawVec = makeRawVector()
      // API returns only 1 embedding for 2 inputs
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: rawVec, index: 0 }],
      })

      await expect(service.embedBatch(['text a', 'text b'])).rejects.toThrow(EmbeddingUnavailableError)
    })

    it('throws EmbeddingUnavailableError when any embedding has wrong dimensions', async () => {
      const goodVec = makeRawVector() // 768-dim
      const badVec = new Array(512).fill(0.1) // wrong dim

      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [
          { embedding: goodVec, index: 0 },
          { embedding: badVec, index: 1 },
        ],
      })

      await expect(service.embedBatch(['text a', 'text b'])).rejects.toThrow(EmbeddingUnavailableError)
    })

    it('handles single-text batch correctly', async () => {
      const rawVec = makeRawVector()
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: rawVec, index: 0 }],
      })

      const result = await service.embedBatch(['single text'])

      expect(result).toHaveLength(1)
      expect(result[0]).toHaveLength(768)
      expect(checkUnitLength(result[0])).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // getModelInfo()
  // -------------------------------------------------------------------------

  describe('getModelInfo()', () => {
    it('returns model alias, dimensions, and source URL from config', () => {
      const info = service.getModelInfo()

      expect(info.model).toBe('jetson-embeddings')
      expect(info.dimensions).toBe(768)
      expect(info.source).toBe('https://llm.k4jda.net')
    })
  })
})
