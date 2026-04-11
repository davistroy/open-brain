import type Anthropic from '@anthropic-ai/sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for callClaude(). */
export interface CallClaudeOptions {
  /** Model to use. Default: 'claude-sonnet-4-20250514'. */
  model?: string
  /** Max tokens for the response. Default: 4096. */
  maxTokens?: number
  /** Temperature for generation. Default: undefined (API default). */
  temperature?: number
  /** System prompt (sent as separate `system` parameter, not in messages). */
  systemPrompt?: string
  /** Abort signal for cancellation. */
  signal?: AbortSignal
}

/** Structured result from callClaude(). */
export interface CallClaudeResult {
  /** The text content of Claude's response. */
  text: string
  /** Number of input tokens consumed. */
  inputTokens: number
  /** Number of output tokens generated. */
  outputTokens: number
}

// ---------------------------------------------------------------------------
// Overload signatures
// ---------------------------------------------------------------------------

/**
 * Simple non-agentic LLM call wrapping the Anthropic SDK.
 *
 * Single-message overload: pass a string as the user message.
 */
export async function callClaude(
  client: Anthropic,
  userMessage: string,
  options?: CallClaudeOptions,
): Promise<CallClaudeResult>

/**
 * Multi-turn overload: pass an array of messages with alternating roles.
 */
export async function callClaude(
  client: Anthropic,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: CallClaudeOptions,
): Promise<CallClaudeResult>

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function callClaude(
  client: Anthropic,
  messageOrMessages: string | Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: CallClaudeOptions,
): Promise<CallClaudeResult> {
  const model = options?.model ?? 'claude-sonnet-4-20250514'
  const maxTokens = options?.maxTokens ?? 4096

  const messages: Anthropic.MessageParam[] = typeof messageOrMessages === 'string'
    ? [{ role: 'user' as const, content: messageOrMessages }]
    : messageOrMessages.map((m) => ({ role: m.role, content: m.content }))

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
  }

  const requestOptions: Anthropic.RequestOptions = {}
  if (options?.signal) {
    requestOptions.signal = options.signal
  }

  const response = await client.messages.create(params, requestOptions)

  // Extract text from the first text block (non-agentic, so no tool_use blocks expected)
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  )
  const text = textBlock?.text ?? ''

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}
