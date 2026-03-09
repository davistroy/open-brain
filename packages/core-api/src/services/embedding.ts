import OpenAI from 'openai'
import { ServiceUnavailableError } from '@open-brain/shared'
import type { ConfigService } from '@open-brain/shared'

/**
 * Thrown when LiteLLM is unreachable or returns a non-200 response.
 * BullMQ retries with patient backoff; no fallback is attempted.
 */
export class EmbeddingUnavailableError extends ServiceUnavailableError {
  constructor(message = 'Embedding service unavailable') {
    super(message)
    this.name = 'EmbeddingUnavailableError'
  }
}

const EMBEDDING_DIMENSIONS = 768
const EMBEDDING_TIMEOUT_MS = 30_000

/**
 * Normalizes a vector to unit length (L2 normalization) for cosine similarity.
 */
function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  if (magnitude === 0) return vec
  return vec.map(v => v / magnitude)
}

/**
 * EmbeddingService generates 768-dimensional embeddings via LiteLLM proxy.
 * Routes to Qwen3-Embedding-4B via the `spark-qwen3-embedding-4b` alias.
 * The model returns 2560-dimensional Matryoshka vectors; this service
 * truncates to 768d via slice(0, EMBEDDING_DIMENSIONS).
 *
 * No fallback on failure — throws EmbeddingUnavailableError so BullMQ can retry.
 */
export class EmbeddingService {
  private client: OpenAI
  private configService: ConfigService

  constructor(litellmBaseUrl: string, litellmApiKey: string, configService: ConfigService) {
    this.client = new OpenAI({
      baseURL: litellmBaseUrl,
      apiKey: litellmApiKey,
      timeout: EMBEDDING_TIMEOUT_MS,
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
      })

      const raw = response.data[0]?.embedding
      if (!raw || raw.length < EMBEDDING_DIMENSIONS) {
        throw new EmbeddingUnavailableError(
          `Expected at least ${EMBEDDING_DIMENSIONS}-dimensional embedding, got ${raw?.length ?? 0}`,
        )
      }

      const embedding = raw.length > EMBEDDING_DIMENSIONS ? raw.slice(0, EMBEDDING_DIMENSIONS) : raw
      return normalizeVector(embedding)
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new EmbeddingUnavailableError(`LiteLLM embedding request failed: ${message}`)
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
      })

      const sorted = response.data.sort((a, b) => a.index - b.index)

      if (sorted.length !== texts.length) {
        throw new EmbeddingUnavailableError(
          `Expected ${texts.length} embeddings, got ${sorted.length}`,
        )
      }

      return sorted.map(item => {
        if (!item.embedding || item.embedding.length < EMBEDDING_DIMENSIONS) {
          throw new EmbeddingUnavailableError(
            `Expected at least ${EMBEDDING_DIMENSIONS}-dimensional embedding at index ${item.index}, got ${item.embedding?.length ?? 0}`,
          )
        }
        const truncated = item.embedding.length > EMBEDDING_DIMENSIONS
          ? item.embedding.slice(0, EMBEDDING_DIMENSIONS)
          : item.embedding
        return normalizeVector(truncated)
      })
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new EmbeddingUnavailableError(`LiteLLM batch embedding request failed: ${message}`)
    }
  }

  /**
   * Returns model metadata from config — model alias, dimensions, and LiteLLM source URL.
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
