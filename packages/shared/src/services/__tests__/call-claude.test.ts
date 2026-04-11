import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { callClaude } from '../call-claude.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a mock Anthropic.Message response. */
function mockMessage(opts: {
  content: Anthropic.ContentBlock[]
  inputTokens?: number
  outputTokens?: number
}): Anthropic.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: opts.content,
    stop_reason: 'end_turn',
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
  return { type: 'text', text, citations: null }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('callClaude', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ── Single-message overload ─────────────────────────────────────────────

  it('sends a string user message and returns text result', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('Hello from Claude!')],
        inputTokens: 200,
        outputTokens: 30,
      }),
    )
    const client = createMockClient(createSpy)

    const result = await callClaude(client, 'Hi there')

    expect(result.text).toBe('Hello from Claude!')
    expect(result.inputTokens).toBe(200)
    expect(result.outputTokens).toBe(30)

    // Verify the API call shape
    const [params] = createSpy.mock.calls[0]
    expect(params.messages).toEqual([{ role: 'user', content: 'Hi there' }])
    expect(params.model).toBe('claude-sonnet-4-20250514')
    expect(params.max_tokens).toBe(4096)
  })

  // ── Multi-turn overload ─────────────────────────────────────────────────

  it('sends a messages array for multi-turn conversations', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('Follow-up response')],
      }),
    )
    const client = createMockClient(createSpy)

    const messages = [
      { role: 'user' as const, content: 'First question' },
      { role: 'assistant' as const, content: 'First answer' },
      { role: 'user' as const, content: 'Second question' },
    ]

    const result = await callClaude(client, messages)

    expect(result.text).toBe('Follow-up response')

    const [params] = createSpy.mock.calls[0]
    expect(params.messages).toHaveLength(3)
    expect(params.messages[0]).toEqual({ role: 'user', content: 'First question' })
    expect(params.messages[1]).toEqual({ role: 'assistant', content: 'First answer' })
    expect(params.messages[2]).toEqual({ role: 'user', content: 'Second question' })
  })

  // ── Options ─────────────────────────────────────────────────────────────

  it('passes custom model, maxTokens, and temperature', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Done')] }),
    )
    const client = createMockClient(createSpy)

    await callClaude(client, 'Test', {
      model: 'claude-opus-4-20250514',
      maxTokens: 8192,
      temperature: 0.7,
    })

    const [params] = createSpy.mock.calls[0]
    expect(params.model).toBe('claude-opus-4-20250514')
    expect(params.max_tokens).toBe(8192)
    expect(params.temperature).toBe(0.7)
  })

  it('sends system prompt as separate parameter', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Response')] }),
    )
    const client = createMockClient(createSpy)

    await callClaude(client, 'User message', {
      systemPrompt: 'You are a helpful assistant.',
    })

    const [params] = createSpy.mock.calls[0]
    expect(params.system).toBe('You are a helpful assistant.')
    // System prompt should NOT appear in messages array
    expect(params.messages).toEqual([{ role: 'user', content: 'User message' }])
  })

  it('does not include system key when systemPrompt is not provided', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Response')] }),
    )
    const client = createMockClient(createSpy)

    await callClaude(client, 'Test')

    const [params] = createSpy.mock.calls[0]
    expect(params.system).toBeUndefined()
  })

  it('does not include temperature when not provided', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Response')] }),
    )
    const client = createMockClient(createSpy)

    await callClaude(client, 'Test')

    const [params] = createSpy.mock.calls[0]
    expect(params.temperature).toBeUndefined()
  })

  it('passes abort signal through to request options', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Done')] }),
    )
    const client = createMockClient(createSpy)
    const controller = new AbortController()

    await callClaude(client, 'Test', { signal: controller.signal })

    const [, requestOpts] = createSpy.mock.calls[0]
    expect(requestOpts.signal).toBe(controller.signal)
  })

  it('sends empty request options when no signal provided', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Done')] }),
    )
    const client = createMockClient(createSpy)

    await callClaude(client, 'Test')

    const [, requestOpts] = createSpy.mock.calls[0]
    expect(requestOpts).toEqual({})
  })

  // ── Edge cases ──────────────────────────────────────────────────────────

  it('returns empty string when response has no text blocks', async () => {
    const client = createMockClient(async () =>
      mockMessage({ content: [] }),
    )

    const result = await callClaude(client, 'Test')
    expect(result.text).toBe('')
  })

  it('returns text from first text block only (ignores tool_use blocks)', async () => {
    const client = createMockClient(async () => ({
      id: 'msg_123',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'tool_use' as const, id: 'toolu_1', name: 'test', input: {} },
        textBlock('The actual text'),
      ],
      stop_reason: 'end_turn' as const,
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }))

    const result = await callClaude(client, 'Test')
    expect(result.text).toBe('The actual text')
  })

  it('propagates API errors without catching them', async () => {
    const client = createMockClient(async () => {
      throw new Error('API rate limit exceeded')
    })

    await expect(callClaude(client, 'Test')).rejects.toThrow('API rate limit exceeded')
  })

  it('handles temperature of 0 correctly (explicit zero)', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Deterministic')] }),
    )
    const client = createMockClient(createSpy)

    await callClaude(client, 'Test', { temperature: 0 })

    const [params] = createSpy.mock.calls[0]
    expect(params.temperature).toBe(0)
  })

  it('uses default model and maxTokens when options object is empty', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({ content: [textBlock('Defaults')] }),
    )
    const client = createMockClient(createSpy)

    await callClaude(client, 'Test', {})

    const [params] = createSpy.mock.calls[0]
    expect(params.model).toBe('claude-sonnet-4-20250514')
    expect(params.max_tokens).toBe(4096)
  })

  it('works with multi-turn messages and all options combined', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      mockMessage({
        content: [textBlock('Full options response')],
        inputTokens: 500,
        outputTokens: 100,
      }),
    )
    const client = createMockClient(createSpy)
    const controller = new AbortController()

    const result = await callClaude(
      client,
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How are you?' },
      ],
      {
        model: 'claude-opus-4-20250514',
        maxTokens: 2048,
        temperature: 0.5,
        systemPrompt: 'Be concise.',
        signal: controller.signal,
      },
    )

    expect(result.text).toBe('Full options response')
    expect(result.inputTokens).toBe(500)
    expect(result.outputTokens).toBe(100)

    const [params, requestOpts] = createSpy.mock.calls[0]
    expect(params.model).toBe('claude-opus-4-20250514')
    expect(params.max_tokens).toBe(2048)
    expect(params.temperature).toBe(0.5)
    expect(params.system).toBe('Be concise.')
    expect(params.messages).toHaveLength(3)
    expect(requestOpts.signal).toBe(controller.signal)
  })
})
