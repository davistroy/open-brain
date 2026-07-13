import OpenAI from 'openai'
import { ServiceUnavailableError } from '../utils/errors.js'
import type { ConfigService } from '../config/loader.js'
import type { Database } from '../db/index.js'
import { resolveModelName, getModelEntry } from '../types/config.js'
import { logger } from '../lib/logger.js'
import { recordSpend } from './spend-recorder.js'

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
 * Initial character limit for embedding API input.
 * text-embedding-3-large has a hard 8,191-token limit.
 * First attempt uses 16K chars; if the API rejects for token overflow,
 * the limit is halved and retried (down to MIN_EMBEDDING_CHARS).
 */
const MAX_EMBEDDING_CHARS = 16_000
const MIN_EMBEDDING_CHARS = 2_000

/**
 * Normalizes a vector to unit length (L2 normalization) for cosine similarity.
 */
function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  if (magnitude === 0) return vec
  return vec.map(v => v / magnitude)
}

/** Returns true if the error is a 400 about context length / token limit */
function isTokenOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('maximum context length') || msg.includes('too many tokens')
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
export interface EmbeddingServiceOpts {
  /** Defaults to `process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'`. */
  baseUrl?: string
  apiKey: string
  configService: ConfigService
  /**
   * Optional DB handle. When provided, each embedding call records its spend in
   * `ai_audit_log` (INT-M2) so the budget circuit breaker isn't blind to embedding
   * cost — the high-volume gap behind the 2026-04 bulk-ingest incident. Callers
   * without a DB (e.g. health checks) simply omit it and no row is written.
   */
  db?: Database
}

export class EmbeddingService {
  private client: OpenAI
  private configService: ConfigService
  private baseURL: string
  private db?: Database

  constructor(opts: EmbeddingServiceOpts) {
    this.baseURL = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: opts.apiKey,
      timeout: EMBEDDING_TIMEOUT_MS,
      maxRetries: 0,  // BullMQ handles retries with patient backoff; no SDK-level retries
    })
    this.configService = opts.configService
    this.db = opts.db
  }

  /**
   * Records embedding spend in `ai_audit_log` (INT-M2). No-op without a DB.
   * Cost is read from the `embedding` tier in ai-routing.yaml (never hardcoded);
   * embeddings are input-only, so total_tokens == prompt_tokens.
   * Failures are swallowed by `recordSpend` — never breaks the embedding path.
   */
  private async recordEmbeddingSpend(totalTokens: number, durationMs: number): Promise<void> {
    if (!this.db || totalTokens <= 0) return
    const aiConfig = this.configService.get('ai')
    const entry = getModelEntry(aiConfig, 'embedding')
    const costUsd = (totalTokens * (entry.cost_per_1k_input ?? 0)) / 1000
    await recordSpend(this.db, {
      taskType: 'embedding',
      model: entry.model,
      clientUsed: entry.client,
      costUsd,
      promptTokens: totalTokens,
      totalTokens,
      durationMs,
    })
  }

  /**
   * Returns the resolved model name from ai-routing.yaml config (never hardcoded).
   */
  private getModelName(): string {
    const aiConfig = this.configService.get('ai')
    return resolveModelName(aiConfig, 'embedding')
  }

  /**
   * Truncates text to a given character limit at a word boundary.
   */
  private truncateToLimit(text: string, limit: number): string {
    if (text.length <= limit) return text
    const truncated = text.slice(0, limit)
    const lastSpace = truncated.lastIndexOf(' ')
    return lastSpace > limit * 0.8 ? truncated.slice(0, lastSpace) : truncated
  }

  /**
   * Calls the embedding API with adaptive truncation.
   * Starts at MAX_EMBEDDING_CHARS; if the API rejects for token overflow,
   * halves the limit and retries until MIN_EMBEDDING_CHARS.
   */
  private async embedWithAdaptiveTruncation(text: string, model: string): Promise<number[]> {
    const startedAt = Date.now()
    let limit = MAX_EMBEDDING_CHARS
    let input = this.truncateToLimit(text, limit)
    const wasOriginallyTruncated = input.length < text.length

    if (wasOriginallyTruncated) {
      logger.info(
        { originalLength: text.length, truncatedLength: input.length, charLimit: limit },
        'Content truncated for embedding API token limit',
      )
    }

    while (true) {
      try {
        const response = await this.client.embeddings.create({
          model,
          input,
          dimensions: EMBEDDING_DIMENSIONS,
        })

        const raw = response.data[0]?.embedding
        if (!raw || raw.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbeddingUnavailableError(
            `Expected ${EMBEDDING_DIMENSIONS}-dimensional embedding, got ${raw?.length ?? 0}`,
          )
        }
        await this.recordEmbeddingSpend(response.usage?.total_tokens ?? 0, Date.now() - startedAt)
        return normalizeVector(raw)
      } catch (err) {
        if (err instanceof EmbeddingUnavailableError) throw err

        if (isTokenOverflowError(err) && limit > MIN_EMBEDDING_CHARS) {
          limit = Math.floor(limit / 2)
          input = this.truncateToLimit(text, limit)
          logger.warn(
            { charLimit: limit, inputLength: input.length },
            'Token overflow — retrying with shorter input',
          )
          continue
        }

        const message = err instanceof Error ? err.message : String(err)
        throw new EmbeddingUnavailableError(`Embedding request failed: ${message}`)
      }
    }
  }

  /**
   * Embeds a single text and returns a normalized 768-dimensional vector.
   * Adaptively truncates content that exceeds the model's token limit.
   * Throws EmbeddingUnavailableError on any failure.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedWithAdaptiveTruncation(text, this.getModelName())
  }

  /**
   * Embeds multiple texts in a single API request and returns normalized vectors.
   *
   * PE-M2 hardening: `embedBatch` uses fixed (non-adaptive) truncation to
   * MAX_EMBEDDING_CHARS for every item. If the batch as a whole is rejected
   * for token overflow (one or more chunks still too large after the fixed
   * truncation), the batch is NOT failed outright — it falls back to
   * per-chunk `embed()` calls, which DO have adaptive truncation. This
   * isolates and rescues the oversized chunk(s) instead of failing chunks
   * that were perfectly embeddable. See `embedBatchPerChunkFallback`.
   *
   * Any other failure (network, auth, API contract violation such as a
   * result-count or dimension mismatch) remains all-or-nothing and throws
   * EmbeddingUnavailableError — those aren't per-chunk problems a fallback
   * could isolate.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const model = this.getModelName()
    const truncatedTexts = texts.map(t => this.truncateToLimit(t, MAX_EMBEDDING_CHARS))
    const startedAt = Date.now()

    try {
      const response = await this.client.embeddings.create({
        model,
        input: truncatedTexts,
        dimensions: EMBEDDING_DIMENSIONS,
      })

      const sorted = response.data.sort((a, b) => a.index - b.index)

      if (sorted.length !== texts.length) {
        throw new EmbeddingUnavailableError(
          `Expected ${texts.length} embeddings, got ${sorted.length}`,
        )
      }

      const vectors = sorted.map(item => {
        if (!item.embedding || item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbeddingUnavailableError(
            `Expected ${EMBEDDING_DIMENSIONS}-dimensional embedding at index ${item.index}, got ${item.embedding?.length ?? 0}`,
          )
        }
        return normalizeVector(item.embedding)
      })
      await this.recordEmbeddingSpend(response.usage?.total_tokens ?? 0, Date.now() - startedAt)
      return vectors
    } catch (err) {
      // Batch-level token overflow: fall back to per-chunk embed() (adaptive
      // truncation) so a single oversized chunk can't fail chunks that would
      // otherwise embed fine. API-contract errors (count/dimension mismatch)
      // are already wrapped as EmbeddingUnavailableError above and are NOT
      // token-overflow errors, so they skip this branch and stay fatal.
      if (!(err instanceof EmbeddingUnavailableError) && isTokenOverflowError(err)) {
        logger.warn(
          { batchSize: texts.length },
          'Batch embedding rejected for token overflow — falling back to per-chunk embed',
        )
        return this.embedBatchPerChunkFallback(texts, model)
      }

      if (err instanceof EmbeddingUnavailableError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new EmbeddingUnavailableError(`Batch embedding request failed: ${message}`)
    }
  }

  /**
   * Per-chunk fallback for `embedBatch` when the batch request is rejected
   * for token overflow. Each text is embedded individually via the adaptive
   * `embedWithAdaptiveTruncation` path (same as `embed()`), preserving input
   * order 1:1 with the batch. Still all-or-nothing: if an individual chunk
   * fails for a non-recoverable reason, the fallback (and therefore the
   * batch) throws — callers already treat batch failures as non-fatal and
   * retry later (e.g. daily sweep).
   *
   * Spend-recording trade-off: the batch path records ONE `ai_audit_log` row
   * per call. This fallback records one row PER CHUNK (each `embed()` call
   * records its own spend) — acceptable because it only fires on the rare
   * token-overflow path, not on normal batch traffic.
   */
  private async embedBatchPerChunkFallback(texts: string[], model: string): Promise<number[][]> {
    const vectors: number[][] = []
    for (const text of texts) {
      vectors.push(await this.embedWithAdaptiveTruncation(text, model))
    }
    return vectors
  }

  /**
   * Returns model metadata from config — model alias, dimensions, and API base URL.
   */
  getModelInfo(): { model: string; dimensions: number; source: string } {
    const aiConfig = this.configService.get('ai')
    return {
      model: resolveModelName(aiConfig, 'embedding'),
      dimensions: EMBEDDING_DIMENSIONS,
      source: this.baseURL,
    }
  }
}
