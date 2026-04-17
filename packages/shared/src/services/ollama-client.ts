import OpenAI from 'openai'

const DEFAULT_OLLAMA_URL = 'http://ollama:11434/v1'

export type OllamaTimeoutTier = 'fast' | 'standard' | 'extended'

const TIMEOUT_MS: Record<OllamaTimeoutTier, number> = {
  fast: 10_000,
  standard: 30_000,
  extended: 60_000,
}

export interface CreateOllamaClientOptions {
  /** Ollama base URL. Default: env OLLAMA_URL ?? 'http://ollama:11434/v1' */
  baseUrl?: string
  /** Timeout tier or milliseconds. Default: 'standard' (30s) */
  timeout?: OllamaTimeoutTier | number
  /** SDK retry count. Default: 0 (local inference — fail fast, let BullMQ handle retries). */
  maxRetries?: number
}

/**
 * Creates an OpenAI SDK client configured for Ollama's OpenAI-compatible endpoint.
 *
 * Ollama exposes /v1/chat/completions with the same interface as OpenAI,
 * so we reuse the existing OpenAI SDK. No API key is needed for local Ollama.
 *
 * Returns `null` if OLLAMA_URL is empty or missing — callers should check
 * and disable local inference accordingly (same pattern as createOpenAIClient).
 */
export function createOllamaClient(opts?: CreateOllamaClientOptions): OpenAI | null {
  const baseURL = opts?.baseUrl ?? process.env.OLLAMA_URL ?? ''
  if (!baseURL) return null

  // Ensure the URL ends with /v1 for OpenAI SDK compatibility
  const normalizedURL = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`

  const timeout = typeof opts?.timeout === 'number'
    ? opts.timeout
    : TIMEOUT_MS[opts?.timeout ?? 'standard']

  return new OpenAI({
    baseURL: normalizedURL,
    apiKey: 'ollama', // Ollama ignores this but the OpenAI SDK requires a non-empty value
    timeout,
    maxRetries: opts?.maxRetries ?? 0,
  })
}
