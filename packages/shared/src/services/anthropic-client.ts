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
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? ''
  if (!apiKey) return null

  const timeout = typeof opts?.timeout === 'number'
    ? opts.timeout
    : TIMEOUT_MS[opts?.timeout ?? 'standard']

  // OAuth tokens (sk-ant-oat*) must be sent as Authorization: Bearer,
  // not x-api-key. Regular API keys (sk-ant-api*) use x-api-key.
  const isOAuthToken = apiKey.startsWith('sk-ant-oat')

  if (isOAuthToken) {
    return new Anthropic({
      apiKey: 'oauth-placeholder', // SDK requires a non-empty apiKey
      timeout,
      ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      defaultHeaders: {
        'Authorization': `Bearer ${apiKey}`,
        'x-api-key': '', // clear the default x-api-key header
      },
    })
  }

  return new Anthropic({
    apiKey,
    timeout,
    ...(opts?.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  })
}
