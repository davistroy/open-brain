/**
 * Fault-injection test for email-compose via LLMGatewayService (Phase 4 / CS-ι).
 *
 * Verifies the integration path end-to-end:
 *   1. EmailComposeSkill asks the gateway for an agent client resolution.
 *   2. runAgent encounters a transient 429 on first iteration.
 *   3. runAgent calls resolution.fallback(), swaps to the fallback tier's
 *      Anthropic client, retries the same iteration, succeeds.
 *   4. After the loop, gateway.recordAgentCompletion is invoked with the
 *      initial tier key as 2nd arg and the final (succeeding) tier key as
 *      the optional 4th arg (agentResult.finalTierKey = 't1_fast').
 *
 * This complements `run-agent.test.ts` (which tests the resolver path in
 * isolation) by exercising the full skill → gateway → runAgent wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database, ConfigService, AgentClientResolution } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeDb(): Database {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    insert: vi.fn(() => ({
      values: vi.fn(async () => {}),
    })),
  } as unknown as Database
}

function makeConfigService(): ConfigService {
  return {
    get: vi.fn((slice: string) => {
      if (slice === 'ai') {
        return {
          models: {},
          task_routing: { email_compose: 't2_quality' },
          model_tiers: {
            t2_quality: {
              provider: 'anthropic',
              model: 'claude-sonnet-primary',
              max_completion_tokens: 4096,
              timeout_ms: 60_000,
              fallback: 't1_fast',
            },
            t1_fast: {
              provider: 'anthropic',
              model: 'claude-haiku-fallback',
              max_completion_tokens: 4096,
              timeout_ms: 30_000,
              fallback: null,
            },
          },
        }
      }
      return undefined
    }),
  } as unknown as ConfigService
}

/** Build a mock Anthropic client with a custom messages.create implementation. */
function mockAnthropicClient(createFn: ReturnType<typeof vi.fn>): Anthropic {
  return {
    messages: { create: createFn },
  } as unknown as Anthropic
}

/** Build an AgentClientResolution with a programmable fallback. */
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

/** Successful Anthropic Message response (end_turn, text only). */
function endTurnMessage(text: string): Anthropic.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude',
    content: [
      { type: 'text', text, citations: null as unknown as never } as Anthropic.TextBlock,
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('email-compose fault injection — gateway fallback', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    // Stub fetch so autonomy gate (minimum_autonomy='advise') passes
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ value: 'partner' }),
    } as unknown as Response)
  })

  it('swaps to the fallback tier on 429 and records completion with the succeeding tier', async () => {
    // Primary client: 429 on first call
    const primaryCreate = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('rate_limit_error'), { status: 429 }),
    )
    const primaryClient = mockAnthropicClient(primaryCreate)

    // Fallback client: returns an end_turn response
    const fallbackCreate = vi.fn().mockResolvedValue(endTurnMessage('Drafted OK'))
    const fallbackClient = mockAnthropicClient(fallbackCreate)

    // Build the resolution chain: primary -> fallback -> null
    const fallbackResolution = makeResolution(fallbackClient, 'claude-haiku-fallback', 't1_fast')
    const primaryResolution = makeResolution(
      primaryClient,
      'claude-sonnet-primary',
      't2_quality',
      () => fallbackResolution,
    )

    // Stub the gateway: resolveAgentClient returns the primary resolution
    const resolveSpy = vi.fn(() => primaryResolution)
    const recordSpy = vi.fn(async () => {})
    const llmGateway = {
      resolveAgentClient: resolveSpy,
      recordAgentCompletion: recordSpy,
    } as unknown as import('@open-brain/shared').LLMGatewayService

    const db = makeDb()
    const configService = makeConfigService()

    const { EmailComposeSkill } = await import('../skills/email-compose.js')
    const skill = new EmailComposeSkill({
      db,
      configService,
      anthropicClient: primaryClient,
      llmGateway,
    })

    const result = await skill.execute({ instruction: 'Email Alice about Q4 planning' })

    // Assertion 1: gateway was asked to resolve the task client
    expect(resolveSpy).toHaveBeenCalledWith('email_compose')

    // Assertion 2: primary client was hit once (429), fallback was hit once (success)
    expect(primaryCreate).toHaveBeenCalledTimes(1)
    expect(fallbackCreate).toHaveBeenCalledTimes(1)

    // Assertion 3: fallback call used the fallback model
    const fallbackCall = fallbackCreate.mock.calls[0] as unknown as [{ model: string }]
    expect(fallbackCall[0].model).toBe('claude-haiku-fallback')

    // Assertion 4: recordAgentCompletion called with initial tier as 2nd arg and
    // final (succeeding) tier as optional 4th arg.
    expect(recordSpy).toHaveBeenCalledTimes(1)
    const recordCall = recordSpy.mock.calls[0] as unknown as [
      string,
      string,
      { iterations: number; tokenUsage: { input: number; output: number }; latencyMs: number },
      string | undefined,
    ]
    expect(recordCall[0]).toBe('email_compose')
    expect(recordCall[1]).toBe('t2_quality')
    expect(recordCall[2].iterations).toBe(1)
    expect(recordCall[2].tokenUsage).toEqual({ input: 100, output: 50 })
    expect(recordCall[2].latencyMs).toBeGreaterThanOrEqual(0)
    const finalTierKeyArg = recordCall[3] as string | undefined
    expect(finalTierKeyArg).toBe('t1_fast')

    // Assertion 5: skill completed without error
    expect(result.agentIterations).toBe(1)
  })

  it('propagates error when fallback chain is exhausted', async () => {
    const primaryCreate = vi.fn().mockRejectedValue(
      Object.assign(new Error('overloaded_error'), { status: 503 }),
    )
    const primaryClient = mockAnthropicClient(primaryCreate)

    // No fallback — chain exhausted immediately
    const primaryResolution = makeResolution(primaryClient, 'claude-sonnet', 't2_quality', () => null)

    const resolveSpy = vi.fn(() => primaryResolution)
    const recordSpy = vi.fn(async () => {})
    const llmGateway = {
      resolveAgentClient: resolveSpy,
      recordAgentCompletion: recordSpy,
    } as unknown as import('@open-brain/shared').LLMGatewayService

    const db = makeDb()
    const configService = makeConfigService()

    const { EmailComposeSkill } = await import('../skills/email-compose.js')
    const skill = new EmailComposeSkill({
      db,
      configService,
      anthropicClient: primaryClient,
      llmGateway,
    })

    await expect(
      skill.execute({ instruction: 'Draft an email' }),
    ).rejects.toThrow('overloaded_error')

    // recordAgentCompletion should NOT be called when the loop throws
    expect(recordSpy).not.toHaveBeenCalled()
  })
})
