import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AIConfig, ConfigService, Database } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock runAgent — must be hoisted before EmailComposeAssistService import
// ---------------------------------------------------------------------------

const mockRunAgent = vi.fn()

vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-brain/shared')>()
  return {
    ...actual,
    runAgent: (...args: unknown[]) => mockRunAgent(...args),
  }
})

import { EmailComposeAssistService } from '../services/email-compose-assist.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAIConfig(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    models: {
      fast: { model: 'gpt-5.4', max_completion_tokens: 1024, timeout_ms: 30_000 },
      synthesis: { model: 'gpt-5.4', max_completion_tokens: 4096, timeout_ms: 60_000 },
      governance: { model: 'gpt-5.4', max_completion_tokens: 4096, timeout_ms: 60_000 },
      intent: { model: 'gpt-5.4', max_completion_tokens: 256, timeout_ms: 10_000 },
      embedding: { model: 'text-embedding-3-large', dimensions: 768 },
    },
    monthly_budget: { soft_limit_usd: 30, hard_limit_usd: 50 },
    task_routing: { email_compose: 't2_quality' },
    model_tiers: {
      t2_quality: {
        model: 'claude-sonnet-4-6',
        max_completion_tokens: 4096,
        timeout_ms: 60_000,
        fallback: null,
      },
    },
    ...overrides,
  } as AIConfig
}

function makeMockConfigService(aiConfig: AIConfig): ConfigService {
  return {
    get: vi.fn((key: string) => {
      if (key === 'ai') return aiConfig
      throw new Error(`unexpected ConfigService.get(${key}) in test`)
    }),
  } as unknown as ConfigService
}

function makeMockDb(): Database {
  return { execute: vi.fn() } as unknown as Database
}

function makeMockAnthropic(): Anthropic {
  return {} as unknown as Anthropic
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailComposeAssistService', () => {
  beforeEach(() => {
    mockRunAgent.mockReset()
  })

  it('resolves the email_compose model at construction via resolveTaskModel', () => {
    const configService = makeMockConfigService(makeAIConfig())
    const service = new EmailComposeAssistService(
      makeMockDb(),
      makeMockAnthropic(),
      configService,
    )

    expect(service).toBeDefined()
    // ConfigService.get('ai') must have been called at INIT, not deferred to compose().
    expect(configService.get).toHaveBeenCalledWith('ai')
  })

  it('passes the tier-resolved model string to runAgent (not a hardcoded literal)', async () => {
    const configService = makeMockConfigService(makeAIConfig())
    const service = new EmailComposeAssistService(
      makeMockDb(),
      makeMockAnthropic(),
      configService,
    )

    mockRunAgent.mockResolvedValue({
      text: '',
      toolCalls: [
        {
          name: 'submit_draft',
          isError: false,
          input: { body: 'Hi Alice,\n\nThanks.\n\nTroy' },
        },
      ],
      iterations: 1,
      duration: 42,
    })

    const result = await service.compose({
      instruction: 'Reply to Alice',
    })

    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    const [, , , options] = mockRunAgent.mock.calls[0]!
    // Must match the t2_quality tier model from the fixture, NOT the old
    // 'claude-sonnet-4-5-20250929' literal.
    expect(options.model).toBe('claude-sonnet-4-6')
    expect(options.model).not.toBe('claude-sonnet-4-5-20250929')

    expect(result.body).toContain('Alice')
  })

  it('reuses the resolved model across multiple compose() calls (INIT-time resolution)', async () => {
    const aiConfig = makeAIConfig()
    const configService = makeMockConfigService(aiConfig)
    const service = new EmailComposeAssistService(
      makeMockDb(),
      makeMockAnthropic(),
      configService,
    )

    // Count get() calls after construction — compose() must not read config again.
    const getCallsAfterInit = (configService.get as ReturnType<typeof vi.fn>).mock.calls.length

    mockRunAgent.mockResolvedValue({
      text: '',
      toolCalls: [
        { name: 'submit_draft', isError: false, input: { body: 'draft 1' } },
      ],
      iterations: 1,
      duration: 10,
    })

    await service.compose({ instruction: 'one' })
    await service.compose({ instruction: 'two' })

    // Neither compose() call should trigger a new configService.get('ai').
    expect((configService.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      getCallsAfterInit,
    )
    // Both calls received the same resolved model string.
    const first = mockRunAgent.mock.calls[0]![3].model
    const second = mockRunAgent.mock.calls[1]![3].model
    expect(first).toBe('claude-sonnet-4-6')
    expect(second).toBe('claude-sonnet-4-6')
  })

  it('throws loudly at construction when email_compose is not in task_routing', () => {
    const badConfig = makeAIConfig({ task_routing: {}, model_tiers: {} })
    const configService = makeMockConfigService(badConfig)

    expect(
      () => new EmailComposeAssistService(makeMockDb(), makeMockAnthropic(), configService),
    ).toThrowError(/email_compose/)
  })
})
