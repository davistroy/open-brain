import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { runAgent, type AgentTool } from '../run-agent.js'
import type { AgentClientResolution } from '../llm-gateway.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a mock Anthropic.Message response. */
function mockMessage(opts: {
  content: Anthropic.ContentBlock[]
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
}): Anthropic.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5-20250929',
    content: opts.content,
    stop_reason: (opts.stopReason ?? 'end_turn') as Anthropic.Message['stop_reason'],
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

/** Build a text content block. */
function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null as unknown as Anthropic.TextBlock['citations'] }
}

/** Build a tool_use content block. */
function toolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id?: string,
): Anthropic.ToolUseBlock {
  return {
    type: 'tool_use',
    id: id ?? `toolu_${Math.random().toString(36).slice(2)}`,
    name,
    input,
  }
}

/** Create a mock Anthropic client with a programmable messages.create method. */
function createMockClient(
  createFn: (...args: unknown[]) => Promise<Anthropic.Message>,
): Anthropic {
  return {
    messages: {
      create: createFn,
    },
  } as unknown as Anthropic
}

/** Simple calculator tool for tests. */
function calculatorTool(): AgentTool {
  return {
    name: 'calculator',
    description: 'Perform basic arithmetic',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string', description: 'Math expression to evaluate' },
      },
      required: ['expression'],
    },
    execute: async (input) => {
      const expr = input.expression as string
      // Simple eval for test purposes only
      if (expr === '2+2') return '4'
      if (expr === '10*5') return '50'
      return `Computed: ${expr}`
    },
  }
}

/** Tool that always throws. */
function failingTool(): AgentTool {
  return {
    name: 'failing_tool',
    description: 'A tool that always fails',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
    execute: async () => {
      throw new Error('Tool execution failed: database connection timeout')
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgent', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns text from a simple response with no tool use', async () => {
    const mockClient = createMockClient(async () =>
      mockMessage({
        content: [textBlock('Hello! How can I help you today?')],
        stopReason: 'end_turn',
      }),
    )

    const result = await runAgent(
      'You are a helpful assistant.',
      [],
      'Hi there',
      { client: mockClient },
    )

    expect(result.text).toBe('Hello! How can I help you today?')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.iterations).toBe(1)
    expect(result.stopReason).toBe('end_turn')
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('accumulates token usage from a single turn', async () => {
    const mockClient = createMockClient(async () =>
      mockMessage({
        content: [textBlock('Response')],
        inputTokens: 200,
        outputTokens: 75,
      }),
    )

    const result = await runAgent(
      'System prompt',
      [],
      'User message',
      { client: mockClient },
    )

    expect(result.tokenUsage.inputTokens).toBe(200)
    expect(result.tokenUsage.outputTokens).toBe(75)
  })

  it('executes a single tool call and returns the final response', async () => {
    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      if (callCount === 1) {
        // First call: Claude wants to use the calculator
        return mockMessage({
          content: [
            textBlock('Let me calculate that for you.'),
            toolUseBlock('calculator', { expression: '2+2' }, 'toolu_123'),
          ],
          stopReason: 'tool_use',
          inputTokens: 150,
          outputTokens: 60,
        })
      }
      // Second call: Claude gives the final response
      return mockMessage({
        content: [textBlock('The result of 2+2 is 4.')],
        stopReason: 'end_turn',
        inputTokens: 200,
        outputTokens: 30,
      })
    })

    const result = await runAgent(
      'You are a calculator assistant.',
      [calculatorTool()],
      'What is 2+2?',
      { client: mockClient },
    )

    expect(result.text).toBe('The result of 2+2 is 4.')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('calculator')
    expect(result.toolCalls[0].input).toEqual({ expression: '2+2' })
    expect(result.toolCalls[0].result).toBe('4')
    expect(result.toolCalls[0].isError).toBe(false)
    expect(result.toolCalls[0].iteration).toBe(1)
    expect(result.iterations).toBe(2)
    expect(result.stopReason).toBe('end_turn')

    // Token usage accumulated across both turns
    expect(result.tokenUsage.inputTokens).toBe(350)
    expect(result.tokenUsage.outputTokens).toBe(90)
  })

  it('handles multiple sequential tool calls across iterations', async () => {
    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      if (callCount === 1) {
        return mockMessage({
          content: [
            toolUseBlock('calculator', { expression: '2+2' }, 'toolu_1'),
          ],
          stopReason: 'tool_use',
        })
      }
      if (callCount === 2) {
        return mockMessage({
          content: [
            toolUseBlock('calculator', { expression: '10*5' }, 'toolu_2'),
          ],
          stopReason: 'tool_use',
        })
      }
      return mockMessage({
        content: [textBlock('2+2=4 and 10*5=50')],
        stopReason: 'end_turn',
      })
    })

    const result = await runAgent(
      'System',
      [calculatorTool()],
      'Calculate 2+2 then 10*5',
      { client: mockClient },
    )

    expect(result.text).toBe('2+2=4 and 10*5=50')
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].iteration).toBe(1)
    expect(result.toolCalls[1].iteration).toBe(2)
    expect(result.iterations).toBe(3)
  })

  it('handles parallel tool calls in a single response', async () => {
    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      if (callCount === 1) {
        // Claude requests two tools at once
        return mockMessage({
          content: [
            toolUseBlock('calculator', { expression: '2+2' }, 'toolu_a'),
            toolUseBlock('calculator', { expression: '10*5' }, 'toolu_b'),
          ],
          stopReason: 'tool_use',
        })
      }
      return mockMessage({
        content: [textBlock('Results: 4 and 50')],
        stopReason: 'end_turn',
      })
    })

    const result = await runAgent(
      'System',
      [calculatorTool()],
      'Calculate both',
      { client: mockClient },
    )

    expect(result.toolCalls).toHaveLength(2)
    // Both from the same iteration
    expect(result.toolCalls[0].iteration).toBe(1)
    expect(result.toolCalls[1].iteration).toBe(1)
    expect(result.toolCalls[0].result).toBe('4')
    expect(result.toolCalls[1].result).toBe('50')
    expect(result.iterations).toBe(2)
  })

  it('handles tool execution errors gracefully', async () => {
    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      if (callCount === 1) {
        return mockMessage({
          content: [
            toolUseBlock('failing_tool', {}, 'toolu_fail'),
          ],
          stopReason: 'tool_use',
        })
      }
      return mockMessage({
        content: [textBlock('I encountered an error with the tool, but I can try a different approach.')],
        stopReason: 'end_turn',
      })
    })

    const result = await runAgent(
      'System',
      [failingTool()],
      'Do something',
      { client: mockClient },
    )

    expect(result.text).toBe('I encountered an error with the tool, but I can try a different approach.')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].isError).toBe(true)
    expect(result.toolCalls[0].result).toContain('database connection timeout')
    // Agent did NOT crash — Claude recovered
    expect(result.iterations).toBe(2)
    expect(result.stopReason).toBe('end_turn')
  })

  it('reports unknown tool as error and lets Claude recover', async () => {
    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      if (callCount === 1) {
        return mockMessage({
          content: [
            toolUseBlock('nonexistent_tool', { query: 'test' }, 'toolu_unknown'),
          ],
          stopReason: 'tool_use',
        })
      }
      return mockMessage({
        content: [textBlock('Let me try a different approach.')],
        stopReason: 'end_turn',
      })
    })

    const result = await runAgent(
      'System',
      [calculatorTool()],
      'Use a tool',
      { client: mockClient },
    )

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].isError).toBe(true)
    expect(result.toolCalls[0].result).toContain('unknown tool')
    expect(result.toolCalls[0].result).toContain('calculator')
    expect(result.stopReason).toBe('end_turn')
  })

  it('respects maxIterations and stops the loop', async () => {
    // Claude always requests tool_use, creating an infinite loop
    const mockClient = createMockClient(async () =>
      mockMessage({
        content: [
          textBlock('Let me try again...'),
          toolUseBlock('calculator', { expression: '1+1' }),
        ],
        stopReason: 'tool_use',
      }),
    )

    const result = await runAgent(
      'System',
      [calculatorTool()],
      'Keep going forever',
      { client: mockClient, maxIterations: 3 },
    )

    expect(result.iterations).toBe(3)
    expect(result.toolCalls).toHaveLength(3)
    expect(result.stopReason).toBe('tool_use')
    // Should still have the last text
    expect(result.text).toBe('Let me try again...')
  })

  it('defaults maxIterations to 10', async () => {
    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      return mockMessage({
        content: [
          toolUseBlock('calculator', { expression: '1+1' }),
        ],
        stopReason: 'tool_use',
      })
    })

    const result = await runAgent(
      'System',
      [calculatorTool()],
      'Loop',
      { client: mockClient },
    )

    expect(result.iterations).toBe(10)
    expect(callCount).toBe(10)
  })

  it('passes model and maxTokens to the API', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('Done')],
        stopReason: 'end_turn',
      }),
    )
    const mockClient = createMockClient(createSpy)

    await runAgent(
      'System prompt here',
      [calculatorTool()],
      'User message here',
      {
        client: mockClient,
        model: 'claude-opus-4-20250514',
        maxTokens: 8192,
        temperature: 0.7,
      },
    )

    expect(createSpy).toHaveBeenCalledTimes(1)
    const [params] = createSpy.mock.calls[0]
    expect(params.model).toBe('claude-opus-4-20250514')
    expect(params.max_tokens).toBe(8192)
    expect(params.temperature).toBe(0.7)
    expect(params.system).toBe('System prompt here')
    expect(params.messages).toEqual([
      { role: 'user', content: 'User message here' },
    ])
  })

  it('does not include tools parameter when tools array is empty', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('No tools needed')],
        stopReason: 'end_turn',
      }),
    )
    const mockClient = createMockClient(createSpy)

    await runAgent(
      'System',
      [],
      'Just chat',
      { client: mockClient },
    )

    const [params] = createSpy.mock.calls[0]
    expect(params.tools).toBeUndefined()
  })

  it('includes tools parameter when tools are provided', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('I have tools available')],
        stopReason: 'end_turn',
      }),
    )
    const mockClient = createMockClient(createSpy)

    await runAgent(
      'System',
      [calculatorTool()],
      'Hi',
      { client: mockClient },
    )

    const [params] = createSpy.mock.calls[0]
    expect(params.tools).toHaveLength(1)
    expect(params.tools[0].name).toBe('calculator')
  })

  it('builds correct conversation history across tool iterations', async () => {
    const createSpy = vi.fn()
    let callCount = 0
    createSpy.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return mockMessage({
          content: [
            toolUseBlock('calculator', { expression: '2+2' }, 'toolu_conv'),
          ],
          stopReason: 'tool_use',
        })
      }
      return mockMessage({
        content: [textBlock('The answer is 4')],
        stopReason: 'end_turn',
      })
    })
    const mockClient = createMockClient(createSpy)

    await runAgent(
      'System',
      [calculatorTool()],
      'What is 2+2?',
      { client: mockClient },
    )

    // Verify the second call includes the full conversation history
    expect(createSpy).toHaveBeenCalledTimes(2)
    const secondCallParams = createSpy.mock.calls[1][0]
    expect(secondCallParams.messages).toHaveLength(3) // user, assistant, user (tool_result)
    expect(secondCallParams.messages[0]).toEqual({
      role: 'user',
      content: 'What is 2+2?',
    })
    expect(secondCallParams.messages[1].role).toBe('assistant')
    expect(secondCallParams.messages[2].role).toBe('user')
    // The tool_result message content
    const toolResultContent = secondCallParams.messages[2].content
    expect(toolResultContent).toHaveLength(1)
    expect(toolResultContent[0].type).toBe('tool_result')
    expect(toolResultContent[0].tool_use_id).toBe('toolu_conv')
    expect(toolResultContent[0].content).toBe('4')
    expect(toolResultContent[0].is_error).toBe(false)
  })

  it('handles stop_reason=tool_use with no tool_use blocks gracefully', async () => {
    const mockClient = createMockClient(async () =>
      mockMessage({
        content: [textBlock('I wanted to use a tool but decided not to.')],
        // Artificially set stop_reason to tool_use but include no tool_use blocks
        stopReason: 'tool_use',
      }),
    )

    const result = await runAgent(
      'System',
      [calculatorTool()],
      'Weird edge case',
      { client: mockClient },
    )

    expect(result.text).toBe('I wanted to use a tool but decided not to.')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.iterations).toBe(1)
  })

  it('handles max_length stop reason', async () => {
    const mockClient = createMockClient(async () =>
      mockMessage({
        content: [textBlock('A very long response that got truncated...')],
        stopReason: 'max_tokens',
      }),
    )

    const result = await runAgent(
      'System',
      [],
      'Write a novel',
      { client: mockClient },
    )

    expect(result.text).toBe('A very long response that got truncated...')
    expect(result.stopReason).toBe('max_tokens')
    expect(result.iterations).toBe(1)
  })

  it('concatenates multiple text blocks in a single response', async () => {
    const mockClient = createMockClient(async () =>
      mockMessage({
        content: [
          textBlock('First paragraph.'),
          textBlock('Second paragraph.'),
        ],
        stopReason: 'end_turn',
      }),
    )

    const result = await runAgent(
      'System',
      [],
      'Write two paragraphs',
      { client: mockClient },
    )

    expect(result.text).toBe('First paragraph.\nSecond paragraph.')
  })

  it('measures duration in milliseconds', async () => {
    const mockClient = createMockClient(async () => {
      return mockMessage({
        content: [textBlock('Done')],
        stopReason: 'end_turn',
      })
    })

    const result = await runAgent(
      'System',
      [],
      'Quick',
      { client: mockClient },
    )

    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(typeof result.duration).toBe('number')
  })

  it('propagates API errors (does not silently catch)', async () => {
    const mockClient = createMockClient(async () => {
      throw new Error('API rate limit exceeded')
    })

    await expect(
      runAgent('System', [], 'Hi', { client: mockClient }),
    ).rejects.toThrow('API rate limit exceeded')
  })

  it('handles tool that returns empty string', async () => {
    const emptyTool: AgentTool = {
      name: 'empty_tool',
      description: 'Returns empty string',
      input_schema: { type: 'object' as const, properties: {} },
      execute: async () => '',
    }

    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      if (callCount === 1) {
        return mockMessage({
          content: [toolUseBlock('empty_tool', {}, 'toolu_empty')],
          stopReason: 'tool_use',
        })
      }
      return mockMessage({
        content: [textBlock('Tool returned empty')],
        stopReason: 'end_turn',
      })
    })

    const result = await runAgent(
      'System',
      [emptyTool],
      'Test',
      { client: mockClient },
    )

    expect(result.toolCalls[0].result).toBe('')
    expect(result.toolCalls[0].isError).toBe(false)
  })

  it('handles tool that throws non-Error objects', async () => {
    const stringThrowTool: AgentTool = {
      name: 'string_throw',
      description: 'Throws a string',
      input_schema: { type: 'object' as const, properties: {} },
      execute: async () => {
        throw 'plain string error'
      },
    }

    let callCount = 0
    const mockClient = createMockClient(async () => {
      callCount++
      if (callCount === 1) {
        return mockMessage({
          content: [toolUseBlock('string_throw', {}, 'toolu_str')],
          stopReason: 'tool_use',
        })
      }
      return mockMessage({
        content: [textBlock('Recovered from string error')],
        stopReason: 'end_turn',
      })
    })

    const result = await runAgent(
      'System',
      [stringThrowTool],
      'Test',
      { client: mockClient },
    )

    expect(result.toolCalls[0].isError).toBe(true)
    expect(result.toolCalls[0].result).toContain('plain string error')
  })

  it('uses default model when not specified', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('Done')],
        stopReason: 'end_turn',
      }),
    )
    const mockClient = createMockClient(createSpy)

    await runAgent('System', [], 'Hi', { client: mockClient })

    const [params] = createSpy.mock.calls[0]
    expect(params.model).toBe('claude-sonnet-4-5-20250929')
  })

  it('uses default maxTokens of 4096 when not specified', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('Done')],
        stopReason: 'end_turn',
      }),
    )
    const mockClient = createMockClient(createSpy)

    await runAgent('System', [], 'Hi', { client: mockClient })

    const [params] = createSpy.mock.calls[0]
    expect(params.max_tokens).toBe(4096)
  })

  it('passes abortSignal through to the API', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('Done')],
        stopReason: 'end_turn',
      }),
    )
    const mockClient = createMockClient(createSpy)
    const controller = new AbortController()

    await runAgent('System', [], 'Hi', {
      client: mockClient,
      abortSignal: controller.signal,
    })

    // The signal should be passed as the second argument (request options)
    const [, requestOpts] = createSpy.mock.calls[0]
    expect(requestOpts.signal).toBe(controller.signal)
  })

  // -------------------------------------------------------------------------
  // clientResolver option (Phase 4 / CS-ι)
  // -------------------------------------------------------------------------

  describe('clientResolver option', () => {
    /** Build a resolution fixture with a programmable fallback. */
    function makeResolution(
      client: Anthropic,
      model: string,
      tierKey: string,
      fallback?: () => AgentClientResolution | null,
    ): AgentClientResolution {
      return {
        client,
        model,
        tierKey,
        provider: 'anthropic',
        maxTokens: 4096,
        timeoutMs: 60_000,
        fallback: fallback ?? (() => null),
      }
    }

    it('uses resolution.client and resolution.model, ignoring options.client/model', async () => {
      const createSpy = vi.fn().mockResolvedValue(
        mockMessage({ content: [textBlock('Done')], stopReason: 'end_turn' }),
      )
      const resolvedClient = createMockClient(createSpy)
      const resolution = makeResolution(resolvedClient, 'claude-sonnet-resolved', 't2_quality')

      const result = await runAgent(
        'System',
        [],
        'Hi',
        {
          // These should be ignored when clientResolver is supplied
          client: createMockClient(vi.fn().mockRejectedValue(new Error('should not be used'))),
          model: 'claude-ignored',
          clientResolver: () => resolution,
        },
      )

      expect(createSpy).toHaveBeenCalledTimes(1)
      const [params] = createSpy.mock.calls[0]
      expect(params.model).toBe('claude-sonnet-resolved')
      expect(result.text).toBe('Done')
      expect(result.finalTierKey).toBe('t2_quality')
    })

    it('invokes clientResolver exactly once at loop start', async () => {
      const createSpy = vi.fn().mockResolvedValue(
        mockMessage({ content: [textBlock('Done')], stopReason: 'end_turn' }),
      )
      const resolvedClient = createMockClient(createSpy)
      const resolverSpy = vi.fn(() => makeResolution(resolvedClient, 'claude-x', 't2_quality'))

      await runAgent('System', [], 'Hi', { clientResolver: resolverSpy })

      expect(resolverSpy).toHaveBeenCalledTimes(1)
    })

    it('swaps to fallback tier on transient 429 and retries the same iteration', async () => {
      // Primary client throws a 429 on first call; fallback client succeeds.
      const primarySpy = vi.fn().mockRejectedValue(
        Object.assign(new Error('rate limited'), { status: 429 }),
      )
      const primaryClient = createMockClient(primarySpy)

      const fallbackSpy = vi.fn().mockResolvedValue(
        mockMessage({ content: [textBlock('Recovered')], stopReason: 'end_turn' }),
      )
      const fallbackClient = createMockClient(fallbackSpy)

      const fallbackResolution = makeResolution(fallbackClient, 'claude-haiku-fallback', 't1_fast')
      const primaryResolution = makeResolution(
        primaryClient,
        'claude-sonnet-primary',
        't2_quality',
        () => fallbackResolution,
      )

      const result = await runAgent('System', [], 'Hi', {
        clientResolver: () => primaryResolution,
      })

      expect(primarySpy).toHaveBeenCalledTimes(1)
      expect(fallbackSpy).toHaveBeenCalledTimes(1)

      // Fallback retry should use the fallback model
      const [fallbackParams] = fallbackSpy.mock.calls[0]
      expect(fallbackParams.model).toBe('claude-haiku-fallback')
      expect(result.text).toBe('Recovered')
      expect(result.iterations).toBe(1)
      expect(result.finalTierKey).toBe('t1_fast')
    })

    it('propagates the error when fallback chain is exhausted', async () => {
      const primarySpy = vi.fn().mockRejectedValue(
        Object.assign(new Error('overloaded'), { status: 503 }),
      )
      const primaryClient = createMockClient(primarySpy)

      // No fallback available — returns null
      const primaryResolution = makeResolution(primaryClient, 'claude-sonnet', 't2_quality', () => null)

      await expect(
        runAgent('System', [], 'Hi', { clientResolver: () => primaryResolution }),
      ).rejects.toThrow('overloaded')
      expect(primarySpy).toHaveBeenCalledTimes(1)
    })

    it('propagates non-transient errors without fallback swap', async () => {
      // 400 = non-transient, should NOT trigger a fallback even if available
      const primarySpy = vi.fn().mockRejectedValue(
        Object.assign(new Error('invalid_request_error'), { status: 400 }),
      )
      const primaryClient = createMockClient(primarySpy)

      const fallbackSpy = vi.fn()
      const fallbackClient = createMockClient(fallbackSpy)
      const fallbackResolution = makeResolution(fallbackClient, 'claude-haiku', 't1_fast')
      const primaryResolution = makeResolution(
        primaryClient,
        'claude-sonnet',
        't2_quality',
        () => fallbackResolution,
      )

      await expect(
        runAgent('System', [], 'Hi', { clientResolver: () => primaryResolution }),
      ).rejects.toThrow('invalid_request_error')

      // Fallback should not have been tried
      expect(fallbackSpy).not.toHaveBeenCalled()
    })

    it('legacy signature (client + model) still works — no regression', async () => {
      const createSpy = vi.fn().mockResolvedValue(
        mockMessage({ content: [textBlock('Legacy works')], stopReason: 'end_turn' }),
      )
      const mockClient = createMockClient(createSpy)

      const result = await runAgent('System', [], 'Hi', {
        client: mockClient,
        model: 'claude-legacy-model',
      })

      const [params] = createSpy.mock.calls[0]
      expect(params.model).toBe('claude-legacy-model')
      expect(result.text).toBe('Legacy works')
      expect(result.finalTierKey).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // context budget (GitHub #204) — per-tool-result cap + cumulative token budget
  // -------------------------------------------------------------------------

  describe('context budget', () => {
    /** A tool that returns a caller-controlled string. */
    function fixedTool(name: string, output: string): AgentTool {
      return {
        name,
        description: 'Returns a fixed string',
        input_schema: { type: 'object' as const, properties: {} },
        execute: async () => output,
      }
    }

    it('truncates an over-cap tool result and appends a truncation marker', async () => {
      const huge = 'x'.repeat(50_000)
      const createSpy = vi.fn()
      let callCount = 0
      createSpy.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return mockMessage({
            content: [toolUseBlock('big_tool', {}, 'toolu_big')],
            stopReason: 'tool_use',
          })
        }
        return mockMessage({ content: [textBlock('done')], stopReason: 'end_turn' })
      })
      const mockClient = createMockClient(createSpy)

      const result = await runAgent('System', [fixedTool('big_tool', huge)], 'Do it', {
        client: mockClient,
        maxToolResultChars: 12_000,
      })

      // Returned toolCalls record is truncated + marked
      expect(result.toolCalls[0].result.length).toBeLessThan(huge.length)
      expect(result.toolCalls[0].result.startsWith('x'.repeat(12_000))).toBe(true)
      expect(result.toolCalls[0].result).toContain('[...truncated 38000 chars — context budget]')

      // The tool_result block sent back to the API on the 2nd call is truncated too
      const secondCallParams = createSpy.mock.calls[1][0]
      const toolResultBlock = secondCallParams.messages[2].content[0]
      expect(toolResultBlock.type).toBe('tool_result')
      expect(toolResultBlock.content.length).toBeLessThan(huge.length)
      expect(toolResultBlock.content).toContain('[...truncated')
    })

    it('applies the default 12000-char cap when maxToolResultChars is not provided', async () => {
      const huge = 'y'.repeat(20_000)
      const createSpy = vi.fn()
      let callCount = 0
      createSpy.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return mockMessage({
            content: [toolUseBlock('big_tool', {}, 'toolu_big2')],
            stopReason: 'tool_use',
          })
        }
        return mockMessage({ content: [textBlock('done')], stopReason: 'end_turn' })
      })
      const mockClient = createMockClient(createSpy)

      const result = await runAgent('System', [fixedTool('big_tool', huge)], 'Do it', {
        client: mockClient,
      })

      // 20000 chars → 12000 kept + marker (default cap)
      expect(result.toolCalls[0].result.startsWith('y'.repeat(12_000))).toBe(true)
      expect(result.toolCalls[0].result).toContain('[...truncated 8000 chars — context budget]')
    })

    it('leaves under-cap tool results unchanged (no marker)', async () => {
      const small = 'short result'
      const createSpy = vi.fn()
      let callCount = 0
      createSpy.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return mockMessage({
            content: [toolUseBlock('small_tool', {}, 'toolu_s')],
            stopReason: 'tool_use',
          })
        }
        return mockMessage({ content: [textBlock('done')], stopReason: 'end_turn' })
      })
      const mockClient = createMockClient(createSpy)

      const result = await runAgent('System', [fixedTool('small_tool', small)], 'Do it', {
        client: mockClient,
        maxToolResultChars: 12_000,
      })

      expect(result.toolCalls[0].result).toBe(small)
      expect(result.toolCalls[0].result).not.toContain('[...truncated')
    })

    it('injects a synthetic summarize turn and stops when the cumulative token budget is crossed', async () => {
      // The model always requests a tool — without a budget this would loop to
      // maxIterations. Each turn reports a large input-token count so the
      // cumulative budget is crossed after two turns. On the final (tools
      // withheld) call the mock returns a summary.
      const createSpy = vi.fn()
      createSpy.mockImplementation(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        if (!params.tools) {
          // Tools withheld → the budget-nudge turn; produce the final answer.
          return mockMessage({
            content: [textBlock('Final summary from gathered data')],
            stopReason: 'end_turn',
            inputTokens: 100_000,
          })
        }
        return mockMessage({
          content: [textBlock('working...'), toolUseBlock('calculator', { expression: '1+1' })],
          stopReason: 'tool_use',
          inputTokens: 100_000,
        })
      })
      const mockClient = createMockClient(createSpy)

      const result = await runAgent('System', [calculatorTool()], 'Go', {
        client: mockClient,
        maxContextTokens: 150_000,
        maxIterations: 10,
      })

      // Stopped well before maxIterations: turn 1 (100k) < budget, turn 2 (200k)
      // crosses → summarize turn injected, turn 3 is the final answer.
      expect(result.iterations).toBe(3)
      expect(createSpy).toHaveBeenCalledTimes(3)
      expect(result.text).toBe('Final summary from gathered data')
      expect(result.stopReason).toBe('end_turn')

      // The synthetic summarize turn was appended to the conversation before the
      // final call, and tools were withheld on that final call.
      const finalCallParams = createSpy.mock.calls[2][0]
      expect(finalCallParams.tools).toBeUndefined()
      const lastUserMsg = finalCallParams.messages[finalCallParams.messages.length - 1]
      expect(lastUserMsg.role).toBe('user')
      const budgetText = (lastUserMsg.content as Anthropic.ContentBlockParam[]).find(
        (b) => b.type === 'text',
      ) as { type: 'text'; text: string } | undefined
      expect(budgetText?.text).toContain('Context budget reached')
    })

    it('does not trigger an early stop under the default budget for small results', async () => {
      // Normal token counts (100/turn) never approach the 150k default budget.
      let callCount = 0
      const createSpy = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount < 3) {
          return mockMessage({
            content: [toolUseBlock('calculator', { expression: '1+1' })],
            stopReason: 'tool_use',
          })
        }
        return mockMessage({ content: [textBlock('all done')], stopReason: 'end_turn' })
      })
      const mockClient = createMockClient(createSpy)

      const result = await runAgent('System', [calculatorTool()], 'Go', {
        client: mockClient,
      })

      expect(result.text).toBe('all done')
      expect(result.iterations).toBe(3)
      // Tools were present on every call (no budget stop occurred)
      for (const call of createSpy.mock.calls) {
        expect(call[0].tools).toHaveLength(1)
      }
    })
  })
})
