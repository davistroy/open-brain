import OpenAI from 'openai'
import { ServiceUnavailableError } from '../utils/errors.js'
import type { ConfigService } from '../config/loader.js'

/**
 * Thrown when the embedding API is unreachable or returns a non-200 response.
 * BullMQ retries with patient backoff; no fallback is attempted.
 */
export class EmbeddingUnavailableError extends ServiceUnavailableError {
  constructor(message = 'Embedding service unavailable') {
    super(message)
    this.name = 'EmbeddingUnavailableError'
  }
}

const EMBEDDING_DIMENSIONS = 768
const EMBEDDING_TIMEOUT_MS = 60_000

/**
 * Normalizes a vector to unit length (L2 normalization) for cosine similarity.
 */
function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  if (magnitude === 0) return vec
  return vec.map(v => v / magnitude)
}

/**
 * EmbeddingService generates 768-dimensional embeddings via the OpenAI API.
 * Uses text-embedding-3-large with dimensions=768 for highest quality at
 * the target dimensionality. The API handles dimension reduction internally
 * (trained MRL, not naive truncation).
 *
 * Lives in @open-brain/shared so both core-api and workers can import it
 * without a circular dependency.
 *
 * No fallback on failure — throws EmbeddingUnavailableError so BullMQ can retry.
 */
export class EmbeddingService {
  private client: OpenAI
  private configService: ConfigService

  constructor(baseUrl: string, apiKey: string, configService: ConfigService) {
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey,
      timeout: EMBEDDING_TIMEOUT_MS,
      maxRetries: 0,  // BullMQ handles retries with patient backoff; no SDK-level retries
    })
    this.configService = configService
  }

  /**
   * Returns the model alias from ai-routing.yaml config (never hardcoded).
   */
  private getModelAlias(): string {
    const aiConfig = this.configService.get('ai')
    return aiConfig.models.embedding
  }

  /**
   * Embeds a single text and returns a normalized 768-dimensional vector.
   * Throws EmbeddingUnavailableError on any failure.
   */
  async embed(text: string): Promise<number[]> {
    const model = this.getModelAlias()

    try {
      const response = await this.client.embeddings.create({
        model,
        input: text,
        dimensions: EMBEDDING_DIMENSIONS,
      })

      const raw = response.data[0]?.embedding
      if (!raw || raw.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingUnavailableError(
          `Expected ${EMBEDDING_DIMENSIONS}-dimensional embedding, got ${raw?.length ?? 0}`,
        )
      }

      return normalizeVector(raw)
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new EmbeddingUnavailableError(`Embedding request failed: ${message}`)
    }
  }

  /**
   * Embeds multiple texts in a single API request and returns normalized vectors.
   * Throws EmbeddingUnavailableError on any failure — no partial results.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const model = this.getModelAlias()

    try {
      const response = await this.client.embeddings.create({
        model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      })

      const sorted = response.data.sort((a, b) => a.index - b.index)

      if (sorted.length !== texts.length) {
        throw new EmbeddingUnavailableError(
          `Expected ${texts.length} embeddings, got ${sorted.length}`,
        )
      }

      return sorted.map(item => {
        if (!item.embedding || item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbeddingUnavailableError(
            `Expected ${EMBEDDING_DIMENSIONS}-dimensional embedding at index ${item.index}, got ${item.embedding?.length ?? 0}`,
          )
        }
        return normalizeVector(item.embedding)
      })
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new EmbeddingUnavailableError(`Batch embedding request failed: ${message}`)
    }
  }

  /**
   * Returns model metadata from config — model alias, dimensions, and API base URL.
   */
  getModelInfo(): { model: string; dimensions: number; source: string } {
    const aiConfig = this.configService.get('ai')
    return {
      model: aiConfig.models.embedding,
      dimensions: EMBEDDING_DIMENSIONS,
      source: aiConfig.litellm_url,
    }
  }
}
