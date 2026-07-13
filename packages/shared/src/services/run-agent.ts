import Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { createLogger } from '../lib/logger.js'
import { estimateTokens } from '../utils/tokens.js'
import type { AgentClientResolution } from './llm-gateway.js'

const logger = createLogger('run-agent')

/** Default per-tool-result character cap (context budget). */
const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000
/** Default cumulative input-token budget across the agent loop (context budget). */
const DEFAULT_MAX_CONTEXT_TOKENS = 150_000
/** Synthetic user turn injected when the cumulative token budget is crossed. */
const CONTEXT_BUDGET_MESSAGE =
  'Context budget reached — produce your final answer now from what you already have. Do not request any more tools.'

/**
 * Detect transient API errors worth a one-shot fallback swap in the agent loop.
 *
 * Intentionally narrow: checks Anthropic-style `.status` (429 rate-limit,
 * 503 overloaded), timeout error codes, and the common network error codes
 * (ECONNREFUSED, ETIMEDOUT). Does NOT match 4xx client errors other than 429
 * (no point swapping models on a 400 schema error) and does NOT match generic
 * `Error` instances without a clear transient signature.
 */
function isTransientAgentError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: number; code?: string; name?: string; message?: string }

  // Anthropic/OpenAI SDK errors carry HTTP status on the thrown error
  if (e.status === 429 || e.status === 503 || e.status === 502 || e.status === 504) return true

  // Node/undici transient network errors
  if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return true

  // Explicit timeout / abort classes
  if (e.name === 'APITimeoutError' || e.name === 'AbortError') return true

  // Last-resort message match for SDKs that don't set status (defensive, narrow)
  const msg = typeof e.message === 'string' ? e.message : ''
  return /\b(429|503)\b|rate[_ -]?limit|overloaded|timeout/i.test(msg)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tool definition with execute function and Anthropic-compatible schema. */
export interface AgentTool {
  /** Tool name (must match the name in the Anthropic tool schema). */
  name: string
  /** Human-readable description for Claude. */
  description: string
  /** JSON Schema describing the tool input (Anthropic input_schema format). */
  input_schema: Anthropic.Tool['input_schema']
  /**
   * Execute the tool with the given input.
   * Return a string result (or throw — errors are caught and reported to Claude).
   */
  execute: (input: Record<string, unknown>) => Promise<string>
}

/** Record of a single tool call made during the agent loop. */
export interface AgentToolCall {
  /** Tool name that was invoked. */
  name: string
  /** Input passed to the tool. */
  input: Record<string, unknown>
  /** Result returned by the tool (or error message). */
  result: string
  /** Whether the tool execution threw an error. */
  isError: boolean
  /** Iteration number (1-based) when this call was made. */
  iteration: number
}

/** Aggregated token usage across all turns. */
export interface AgentTokenUsage {
  inputTokens: number
  outputTokens: number
  /** Cache-related tokens (if present in response). */
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/** Result returned by runAgent(). */
export interface AgentResult {
  /** Final text response from Claude after the tool loop completes. */
  text: string
  /** All tool calls made during the conversation (in order). */
  toolCalls: AgentToolCall[]
  /** Aggregated token usage across all turns. */
  tokenUsage: AgentTokenUsage
  /** Total wall-clock duration in milliseconds. */
  duration: number
  /** Number of tool-use iterations executed. */
  iterations: number
  /** The stop reason from the final API response. */
  stopReason: string
  /**
   * Tier key of the tier that ultimately served the final iteration.
   * Matches the initial resolved tier when no fallback swap occurred.
   * Undefined when runAgent is called without a clientResolver (legacy path).
   */
  finalTierKey?: string
}

/** Options for runAgent(). */
export interface RunAgentOptions {
  /**
   * Anthropic client instance. If not provided (and no `clientResolver`),
   * creates one from ANTHROPIC_API_KEY env var. Ignored when `clientResolver`
   * is supplied.
   */
  client?: Anthropic
  /**
   * Model to use. Default: `'claude-sonnet-4-5-20250929'`. Ignored when
   * `clientResolver` is supplied — the resolution's `model` wins.
   */
  model?: string
  /** Maximum tool-use loop iterations. Default: 10. */
  maxIterations?: number
  /** Max tokens for each API call. Default: 4096. */
  maxTokens?: number
  /**
   * Per-tool-result character cap (context budget). Each tool result is clamped
   * to this many characters before being appended as a tool_result block, with a
   * visible truncation marker. Bounds the context contributed by any single tool
   * call. Default: 12000. Tools that already return small results are unaffected.
   */
  maxToolResultChars?: number
  /**
   * Cumulative input-token budget for the whole loop (context budget). After each
   * turn's usage is accumulated, if the running input-token total crosses this
   * value, `runAgent` injects a synthetic "summarize now" user turn and stops at
   * the next iteration boundary (never truncating mid-toolResults assembly).
   * Prevents unbounded token blowups from tools that return large payloads.
   * Default: 150000.
   */
  maxContextTokens?: number
  /** Temperature for generation. Default: undefined (API default). */
  temperature?: number
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal
  /**
   * Optional factory that returns a live `AgentClientResolution`.
   *
   * When supplied, `runAgent` uses `resolution.client` + `resolution.model`
   * instead of the `client` + `model` fields above. On transient API errors
   * (429, 503, timeouts, ECONNREFUSED/RESET) inside the loop, `runAgent`
   * calls `resolution.fallback()`; if it returns a non-null resolution, the
   * client and model are swapped and the **same iteration** is retried once.
   *
   * Hard cap: one fallback swap per iteration. Further transients in the same
   * iteration propagate (prevents runaway loops on persistent provider outage).
   *
   * Source: the LLMGatewayService-native pattern; see
   * `LLMGatewayService.resolveAgentClient()`. The factory is called **once**
   * at loop start (agent state is stateful and cannot swap mid-conversation
   * gracefully); fallback closures advance within that single resolution.
   */
  clientResolver?: () => AgentClientResolution
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Duck-type check: does the object look like an Anthropic SDK client?
 * Used to guard against cross-provider `clientResolver` misconfigurations.
 * An OpenAI SDK client has `.chat.completions.create`, not `.messages.create`.
 */
function isAnthropicLike(client: Anthropic | OpenAI): client is Anthropic {
  return (
    typeof client === 'object' &&
    client !== null &&
    'messages' in client &&
    typeof (client as { messages?: { create?: unknown } }).messages?.create === 'function'
  )
}

/**
 * Clamp a tool result to a maximum character count, appending a visible
 * truncation marker when truncation occurs. Under-cap results are returned
 * unchanged. Prevents any single tool call from flooding the context window
 * (root cause of GitHub #204's 6.5M-token blowup).
 */
function clampToolResult(result: string, maxChars: number): string {
  if (result.length <= maxChars) return result
  const removed = result.length - maxChars
  return `${result.slice(0, maxChars)}\n\n[...truncated ${removed} chars — context budget]`
}

/** Convert AgentTool[] to the Anthropic SDK tool format. */
function toAnthropicTools(tools: AgentTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

/** Extract all text blocks from a Message response and concatenate them. */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Accumulate token usage from a Message response. */
function accumulateUsage(
  acc: AgentTokenUsage,
  usage: Anthropic.Usage,
): void {
  acc.inputTokens += usage.input_tokens
  acc.outputTokens += usage.output_tokens
  // Cache fields may be present on the usage object
  const u = usage as unknown as Record<string, unknown>
  if (typeof u.cache_creation_input_tokens === 'number') {
    acc.cacheCreationInputTokens += u.cache_creation_input_tokens
  }
  if (typeof u.cache_read_input_tokens === 'number') {
    acc.cacheReadInputTokens += u.cache_read_input_tokens
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Runs a Claude tool-use agent loop.
 *
 * Sends an initial message to Claude with the given system prompt, tools, and
 * user message. If Claude responds with `tool_use` blocks, the corresponding
 * tool execute functions are called, results are appended to the conversation,
 * and Claude is called again. This repeats until Claude returns `end_turn` (or
 * `max_length`) or the iteration limit is reached.
 *
 * Tool execution errors are caught and reported to Claude as `is_error: true`
 * tool results, allowing Claude to recover gracefully.
 *
 * @param systemPrompt - System prompt for Claude.
 * @param tools - Array of tool definitions with execute functions.
 * @param userMessage - The user's message to start the conversation.
 * @param options - Configuration options (client, model, maxIterations, etc.).
 * @returns Structured result with final text, tool calls, token usage, and duration.
 */
export async function runAgent(
  systemPrompt: string,
  tools: AgentTool[],
  userMessage: string,
  options?: RunAgentOptions,
): Promise<AgentResult> {
  const startTime = Date.now()

  // If a clientResolver is provided, it owns client/model resolution + fallback
  // chain. Resolved once at loop start; fallback hops happen via resolution.fallback().
  let resolution: AgentClientResolution | null = options?.clientResolver ? options.clientResolver() : null

  // `client` and `model` are mutable: they may swap mid-loop when resolution.fallback()
  // returns a non-null next hop on transient errors.
  let client: Anthropic = resolution
    ? (resolution.client as Anthropic)
    : (options?.client ?? new Anthropic())
  let model: string = resolution ? resolution.model : (options?.model ?? 'claude-sonnet-4-5-20250929')
  const maxIterations = options?.maxIterations ?? 10
  const maxTokens = options?.maxTokens ?? 4096
  const maxToolResultChars = options?.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
  const maxContextTokens = options?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS

  // Runtime assertion: when a clientResolver is supplied the primary resolution
  // must give us an Anthropic client. Cross-provider agent fallback is out of scope
  // (see LLMGatewayService.resolveAgentClient — chain is filtered same-provider).
  if (resolution && !isAnthropicLike(client)) {
    throw new Error(
      `runAgent requires an Anthropic SDK client; resolver returned provider '${resolution.provider}'. ` +
        `Cross-provider agent loops are not supported — route email-compose etc. to an 'anthropic' tier in ai-routing.yaml.`,
    )
  }

  // Build a lookup map for fast tool resolution
  const toolMap = new Map<string, AgentTool>()
  for (const tool of tools) {
    toolMap.set(tool.name, tool)
  }

  const anthropicTools = toAnthropicTools(tools)
  const allToolCalls: AgentToolCall[] = []
  const tokenUsage: AgentTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }

  // Build the conversation messages array (mutated across iterations)
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ]

  let iteration = 0
  let lastStopReason = 'end_turn'
  let finalText = ''
  let currentTierKey: string | undefined = resolution?.tierKey
  // Context budget state. `budgetReached` = the cumulative token budget has been
  // crossed (decision). `budgetStopInjected` = we have appended the synthetic
  // "summarize now" turn (executed) — the next turn withholds tools and is final.
  let budgetReached = false
  let budgetStopInjected = false

  while (iteration < maxIterations) {
    iteration++

    logger.debug(
      { iteration, maxIterations, messageCount: messages.length },
      'sending messages to Claude',
    )

    // Make the API call. When a clientResolver is active, a single transient
    // error (429/503/timeout) triggers one fallback-swap-and-retry per iteration.
    // Once the budget-stop turn is injected, tools are withheld so the model
    // must produce its final answer in text (it cannot request more context).
    const buildParams = (): Anthropic.MessageCreateParamsNonStreaming => ({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      ...(anthropicTools.length > 0 && !budgetStopInjected ? { tools: anthropicTools } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    })

    let response: Anthropic.Message
    try {
      response = await client.messages.create(buildParams(), { signal: options?.abortSignal })
    } catch (err) {
      // Only the clientResolver path participates in fallback. Legacy callers
      // get the original behavior: errors propagate unchanged.
      if (!resolution || !isTransientAgentError(err)) throw err

      const nextResolution = resolution.fallback?.() ?? null
      if (!nextResolution) {
        // Chain exhausted — propagate the original error unchanged.
        throw err
      }

      if (!isAnthropicLike(nextResolution.client)) {
        // Defensive: same-provider filter in resolveAgentClient should prevent
        // this, but if a custom resolver returns a non-Anthropic client we
        // can't continue the loop gracefully. Re-throw the original error.
        logger.error(
          { fallbackProvider: nextResolution.provider },
          'clientResolver fallback returned non-Anthropic client — cannot swap mid-loop',
        )
        throw err
      }

      logger.warn(
        {
          iteration,
          fromTier: resolution.tierKey,
          fromModel: model,
          toTier: nextResolution.tierKey,
          toModel: nextResolution.model,
          err: err instanceof Error ? err.message : String(err),
        },
        'transient agent-loop error — swapping to fallback tier and retrying same iteration',
      )

      // Swap for the retry. We do NOT update `resolution` for subsequent
      // iterations' fallback starting point — resolution.fallback() already
      // advanced the chain cursor, so the next transient in a later iteration
      // will continue where we left off.
      resolution = nextResolution
      client = nextResolution.client as Anthropic
      model = nextResolution.model
      currentTierKey = nextResolution.tierKey

      // Retry once. If this also throws, the error propagates — no infinite loop.
      response = await client.messages.create(buildParams(), { signal: options?.abortSignal })
    }

    accumulateUsage(tokenUsage, response.usage)
    lastStopReason = response.stop_reason ?? 'end_turn'

    logger.debug(
      {
        iteration,
        stopReason: lastStopReason,
        contentBlocks: response.content.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      'received response from Claude',
    )

    // Extract any text from this response
    const responseText = extractText(response.content)
    if (responseText) {
      finalText = responseText
    }

    // If the previous iteration crossed the token budget, it appended a
    // synthetic "summarize now" turn (with tools withheld). This response IS
    // that final answer — stop unconditionally so the agent cannot request
    // more context, regardless of the reported stop_reason.
    if (budgetStopInjected) {
      logger.warn(
        { iteration, cumulativeInputTokens: tokenUsage.inputTokens, maxContextTokens },
        'agent loop stopped after context-budget summarize turn',
      )
      break
    }

    // Context budget (cumulative input tokens). Once crossed, the current tool
    // round becomes the last: we append the tool results (required by the API
    // for the pending tool_use blocks) plus a synthetic summarize turn, never
    // truncating mid-toolResults assembly.
    if (tokenUsage.inputTokens >= maxContextTokens) {
      budgetReached = true
    }

    // If Claude didn't request tool use, we're done
    if (lastStopReason !== 'tool_use') {
      break
    }

    // Find all tool_use blocks in the response
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )

    if (toolUseBlocks.length === 0) {
      // stop_reason said tool_use but no blocks found — treat as end
      logger.warn({ iteration }, 'stop_reason=tool_use but no tool_use blocks found')
      break
    }

    // Append the assistant response to conversation history
    messages.push({ role: 'assistant', content: response.content })

    // Execute each tool and build tool_result blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const toolUse of toolUseBlocks) {
      const tool = toolMap.get(toolUse.name)
      const input = (toolUse.input ?? {}) as Record<string, unknown>

      let result: string
      let isError = false

      if (!tool) {
        // Unknown tool — report error to Claude so it can recover
        result = `Error: unknown tool "${toolUse.name}". Available tools: ${[...toolMap.keys()].join(', ')}`
        isError = true
        logger.warn({ toolName: toolUse.name, iteration }, 'unknown tool requested')
      } else {
        try {
          result = await tool.execute(input)
        } catch (err) {
          isError = true
          result = `Error executing tool "${toolUse.name}": ${err instanceof Error ? err.message : String(err)}`
          logger.warn(
            { toolName: toolUse.name, err, iteration },
            'tool execution error',
          )
        }
      }

      // Clamp the result to the per-tool-result char cap before it enters the
      // conversation (and the returned toolCalls record). Bounds the context
      // any single tool call can contribute.
      const cappedResult = clampToolResult(result, maxToolResultChars)

      allToolCalls.push({
        name: toolUse.name,
        input,
        result: cappedResult,
        isError,
        iteration,
      })

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: cappedResult,
        is_error: isError,
      })
    }

    // Proactive budget check: estimate the tokens the pending tool results will
    // add. This catches a single large payload on the iteration it is produced,
    // before it is re-sent and compounds across further iterations.
    if (!budgetReached) {
      const pendingResultTokens = estimateTokens(
        toolResults.map((tr) => (typeof tr.content === 'string' ? tr.content : '')).join(''),
      )
      if (tokenUsage.inputTokens + pendingResultTokens >= maxContextTokens) {
        budgetReached = true
      }
    }

    if (budgetReached) {
      // Append the required tool_result blocks plus a synthetic user turn asking
      // the agent to summarize now. Never truncate mid-toolResults assembly —
      // the stop happens on the next iteration boundary.
      logger.warn(
        { iteration, cumulativeInputTokens: tokenUsage.inputTokens, maxContextTokens },
        'context token budget crossed — injecting summarize turn',
      )
      messages.push({
        role: 'user',
        content: [
          ...toolResults,
          { type: 'text', text: CONTEXT_BUDGET_MESSAGE },
        ],
      })
      budgetStopInjected = true
    } else {
      // Append tool results as a user message
      messages.push({ role: 'user', content: toolResults })
    }
  }

  // If we exhausted iterations without end_turn, log a warning
  if (iteration >= maxIterations && lastStopReason === 'tool_use') {
    logger.warn(
      { maxIterations, toolCallCount: allToolCalls.length },
      'agent loop hit max iterations — returning last response',
    )
  }

  const duration = Date.now() - startTime

  logger.info(
    {
      iterations: iteration,
      toolCalls: allToolCalls.length,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      duration,
      stopReason: lastStopReason,
    },
    'agent loop complete',
  )

  return {
    text: finalText,
    toolCalls: allToolCalls,
    tokenUsage,
    duration,
    iterations: iteration,
    stopReason: lastStopReason,
    finalTierKey: currentTierKey,
  }
}
