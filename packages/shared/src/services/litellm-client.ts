import OpenAI from 'openai'

const DEFAULT_LITELLM_URL = 'https://llm.k4jda.net'

export type LiteLLMTimeoutTier = 'fast' | 'standard' | 'extended'

const TIMEOUT_MS: Record<LiteLLMTimeoutTier, number> = {
  fast: 30_000,
  standard: 60_000,
  extended: 120_000,
}

export interface CreateLiteLLMClientOptions {
  /** LiteLLM proxy base URL. Default: env LITELLM_URL ?? 'https://llm.k4jda.net' */
  baseUrl?: string
  /** API key for LiteLLM proxy. Default: env LITELLM_API_KEY. Returns null if empty. */
  apiKey?: string
  /** Timeout tier or milliseconds. Default: 'standard' (60s) */
  timeout?: LiteLLMTimeoutTier | number
  /** SDK retry count. Default: SDK default (2). Set 0 for BullMQ-managed jobs. */
  maxRetries?: number
}

/**
 * Creates an OpenAI SDK client configured for the LiteLLM proxy.
 *
 * Returns `null` if the API key is empty or missing — callers should check
 * and disable LLM features accordingly (following core-api's governance
 * engine pattern).
 */
export function createLiteLLMClient(opts?: CreateLiteLLMClientOptions): OpenAI | null {
  const apiKey = opts?.apiKey ?? process.env.LITELLM_API_KEY ?? ''
  if (!apiKey) return null

  const baseURL = opts?.baseUrl ?? process.env.LITELLM_URL ?? DEFAULT_LITELLM_URL
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
