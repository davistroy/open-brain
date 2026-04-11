import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '../lib/logger.js'

const logger = createLogger('run-agent')

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
}

/** Options for runAgent(). */
export interface RunAgentOptions {
  /** Anthropic client instance. If not provided, creates one from ANTHROPIC_API_KEY env var. */
  client?: Anthropic
  /** Model to use. Default: 'claude-sonnet-4-5-20250929'. */
  model?: string
  /** Maximum tool-use loop iterations. Default: 10. */
  maxIterations?: number
  /** Max tokens for each API call. Default: 4096. */
  maxTokens?: number
  /** Temperature for generation. Default: undefined (API default). */
  temperature?: number
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  const client = options?.client ?? new Anthropic()
  const model = options?.model ?? 'claude-sonnet-4-5-20250929'
  const maxIterations = options?.maxIterations ?? 10
  const maxTokens = options?.maxTokens ?? 4096

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

  while (iteration < maxIterations) {
    iteration++

    logger.debug(
      { iteration, maxIterations, messageCount: messages.length },
      'sending messages to Claude',
    )

    // Make the API call
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    }

    const response = await client.messages.create(requestParams, {
      signal: options?.abortSignal,
    })

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

      allToolCalls.push({
        name: toolUse.name,
        input,
        result,
        isError,
        iteration,
      })

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
        is_error: isError,
      })
    }

    // Append tool results as a user message
    messages.push({ role: 'user', content: toolResults })
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
  }
}
