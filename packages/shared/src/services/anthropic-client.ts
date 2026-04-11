import Anthropic from '@anthropic-ai/sdk'

export type AnthropicTimeoutTier = 'fast' | 'standard' | 'extended'

const TIMEOUT_MS: Record<AnthropicTimeoutTier, number> = {
  fast: 30_000,
  standard: 60_000,
  extended: 120_000,
}

export interface CreateAnthropicClientOptions {
  /** Anthropic API key. Default: env ANTHROPIC_API_KEY. Returns null if empty. */
  apiKey?: string
  /** Timeout tier or milliseconds. Default: 'standard' (60s) */
  timeout?: AnthropicTimeoutTier | number
  /** SDK retry count. Default: SDK default (2). Set 0 for BullMQ-managed jobs. */
  maxRetries?: number
}

/**
 * Creates an Anthropic SDK client for Claude API calls.
 *
 * Returns `null` if the API key is empty or missing — callers should check
 * and disable Claude features accordingly (following the same pattern as
 * createLiteLLMClient).
 *
 * The Claude Code subscription provides API access at $0 marginal cost.
 * This client is used for all LLM inference tasks (fast, synthesis,
 * governance, conversation, intent). Embeddings continue to use the
 * LiteLLM/OpenAI client.
 */
export function createAnthropicClient(opts?: CreateAnthropicClientOptions): Anthropic | null {
  // Check both env vars: ANTHROPIC_AUTH_TOKEN (OAuth/Bearer) and ANTHROPIC_API_KEY (regular key)
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? ''
  if (!apiKey) return null

  const timeout = typeof opts?.timeout === 'number'
    ? opts.timeout
    : TIMEOUT_MS[opts?.timeout ?? 'standard']

  const retries = opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}

  // OAuth tokens (sk-ant-oat*) use authToken (Authorization: Bearer).
  // Regular API keys (sk-ant-api*) use apiKey (x-api-key header).
  // The SDK also auto-reads ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY env vars.
  if (apiKey.startsWith('sk-ant-oat')) {
    return new Anthropic({ authToken: apiKey, timeout, ...retries })
  }

  return new Anthropic({ apiKey, timeout, ...retries })
}
