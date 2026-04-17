import OpenAI from 'openai'

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1'

export type OpenAITimeoutTier = 'fast' | 'standard' | 'extended'

const TIMEOUT_MS: Record<OpenAITimeoutTier, number> = {
  fast: 30_000,
  standard: 60_000,
  extended: 120_000,
}

export interface CreateOpenAIClientOptions {
  /** OpenAI-compatible base URL. Default: `process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'`. */
  baseUrl?: string
  /** API key. Default: `process.env.OPENAI_API_KEY`. Returns null if empty. */
  apiKey?: string
  /** Timeout tier or milliseconds. Default: 'standard' (60s) */
  timeout?: OpenAITimeoutTier | number
  /** SDK retry count. Default: SDK default (2). Set 0 for BullMQ-managed jobs. */
  maxRetries?: number
}

/**
 * Creates an OpenAI SDK client configured for api.openai.com or an
 * OpenAI-compatible endpoint (vLLM, llama.cpp, etc.).
 *
 * Returns `null` if the API key is empty or missing — callers should check
 * and disable LLM features accordingly.
 */
export function createOpenAIClient(opts?: CreateOpenAIClientOptions): OpenAI | null {
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  if (!apiKey) return null

  const baseURL = opts?.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_URL

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
