import OpenAI from 'openai'
import { logger } from '../lib/logger.js'

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1'

export type OpenAITimeoutTier = 'fast' | 'standard' | 'extended'

const TIMEOUT_MS: Record<OpenAITimeoutTier, number> = {
  fast: 30_000,
  standard: 60_000,
  extended: 120_000,
}

export interface CreateOpenAIClientOptions {
  /** OpenAI-compatible base URL. Default: env OPENAI_BASE_URL ?? LITELLM_URL (legacy shim) ?? 'https://api.openai.com/v1' */
  baseUrl?: string
  /** API key. Default: env OPENAI_API_KEY ?? LITELLM_API_KEY (legacy shim). Returns null if empty. */
  apiKey?: string
  /** Timeout tier or milliseconds. Default: 'standard' (60s) */
  timeout?: OpenAITimeoutTier | number
  /** SDK retry count. Default: SDK default (2). Set 0 for BullMQ-managed jobs. */
  maxRetries?: number
}

/**
 * Creates an OpenAI SDK client configured for api.openai.com or an
 * OpenAI-compatible endpoint (LiteLLM proxy, vLLM, etc.).
 *
 * Returns `null` if the API key is empty or missing — callers should check
 * and disable LLM features accordingly (following core-api's governance
 * engine pattern).
 *
 * Transition shim (Phase D): reads `OPENAI_API_KEY` first, then falls back
 * to `LITELLM_API_KEY`. Same for `OPENAI_BASE_URL` / `LITELLM_URL`. When
 * falling back, logs a warn. The shim will be removed once homeserver
 * secrets are renamed.
 */
export function createOpenAIClient(opts?: CreateOpenAIClientOptions): OpenAI | null {
  let apiKey = opts?.apiKey
  if (apiKey === undefined) {
    apiKey = process.env.OPENAI_API_KEY ?? ''
    if (!apiKey && process.env.LITELLM_API_KEY) {
      apiKey = process.env.LITELLM_API_KEY
      logger.warn(
        'createOpenAIClient: using legacy LITELLM_API_KEY env var — rename to OPENAI_API_KEY',
      )
    }
  }
  if (!apiKey) return null

  let baseURL = opts?.baseUrl
  if (baseURL === undefined) {
    baseURL = process.env.OPENAI_BASE_URL ?? ''
    if (!baseURL && process.env.LITELLM_URL) {
      baseURL = process.env.LITELLM_URL
      logger.warn(
        'createOpenAIClient: using legacy LITELLM_URL env var — rename to OPENAI_BASE_URL',
      )
    }
    if (!baseURL) baseURL = DEFAULT_OPENAI_URL
  }

  const timeout = typeof opts?.timeout === 'number'
    ? opts.timeout
    : TIMEOUT_MS[opts?.timeout ?? 'standard']

  return new OpenAI({
    baseURL,
    apiKey,
    timeout,
    ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  })
}
