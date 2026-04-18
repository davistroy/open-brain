import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { LLMGatewayService } from '../llm-gateway.js'
import { ModelResolverError } from '../model-resolver.js'
import type { ConfigService } from '../../config/loader.js'
import type { Database } from '../../db/index.js'
import type { TemplateCache } from '../../lib/prompt-template.js'
import type { ModelTierEntry } from '../../types/config.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal tier factory. */
function mkTier(overrides: Partial<ModelTierEntry> & { model: string; provider: ModelTierEntry['provider'] }): ModelTierEntry {
  return {
    provider: overrides.provider,
    model: overrides.model,
    base_url: overrides.base_url,
    max_completion_tokens: overrides.max_completion_tokens ?? 4096,
    timeout_ms: overrides.timeout_ms ?? 60_000,
    fallback: overrides.fallback ?? null,
  }
}

/** Build a fake ConfigService with the given tier map and task routing. */
function makeConfigService(
  tiers: Record<string, ModelTierEntry>,
  taskRouting: Record<string, string>,
): ConfigService {
  return {
    hasThreeTierRouting: () => true,
    getTaskTierKey: (taskName: string) => taskRouting[taskName],
    getModelTier: (tierKey: string) => tiers[tierKey],
    get: (_slice: string) => ({
      model_tiers: tiers,
      task_routing: taskRouting,
      monthly_budget: { soft_limit_usd: 30, hard_limit_usd: 50 },
    }),
  } as unknown as ConfigService
}

function makeDb(): { db: Database; inserts: unknown[] } {
  const inserts: unknown[] = []
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (v: unknown) => {
        inserts.push(v)
      }),
    })),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as Database
  return { db, inserts }
}

function makeTemplateCache(): TemplateCache {
  return { render: vi.fn() } as unknown as TemplateCache
}

function makeAnthropicClient(): Anthropic {
  return {
    messages: { create: vi.fn() },
  } as unknown as Anthropic
}

// ---------------------------------------------------------------------------
// resolveAgentClient()
// ---------------------------------------------------------------------------

describe('LLMGatewayService.resolveAgentClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves the primary tier and returns a live Anthropic client', () => {
    const tiers = {
      t2_quality: mkTier({ model: 'claude-sonnet-4-6', provider: 'anthropic', fallback: null }),
    }
    const configService = makeConfigService(tiers, { email_compose: 't2_quality' })
    const anthropicClient = makeAnthropicClient()
    const gateway = new LLMGatewayService(
      configService,
      makeDb().db,
      makeTemplateCache(),
      anthropicClient,
      null,
      null,
    )

    const resolution = gateway.resolveAgentClient('email_compose')

    expect(resolution.model).toBe('claude-sonnet-4-6')
    expect(resolution.tierKey).toBe('t2_quality')
    expect(resolution.provider).toBe('anthropic')
    expect(resolution.client).toBe(anthropicClient)
    expect(resolution.maxTokens).toBe(4096)
    expect(typeof resolution.fallback).toBe('function')
  })

  it('throws ModelResolverError on unmapped task', () => {
    const configService = makeConfigService({}, {})
    const gateway = new LLMGatewayService(
      configService,
      makeDb().db,
      makeTemplateCache(),
      makeAnthropicClient(),
      null,
      null,
    )

    expect(() => gateway.resolveAgentClient('unknown_task')).toThrow(ModelResolverError)
  })

  it('excludes cross-provider tiers from the fallback chain', () => {
    // Primary is anthropic; chained fallback is openai_compat — must be filtered.
    const tiers = {
      t2_quality: mkTier({ model: 'claude-sonnet', provider: 'anthropic', fallback: 't1_spark' }),
      t1_spark: mkTier({
        model: 'qwen-35b',
        provider: 'openai_compat',
        base_url: 'http://spark:8000',
        fallback: null,
      }),
    }
    const configService = makeConfigService(tiers, { email_compose: 't2_quality' })
    const gateway = new LLMGatewayService(
      configService,
      makeDb().db,
      makeTemplateCache(),
      makeAnthropicClient(),
      null,
      null,
    )

    const resolution = gateway.resolveAgentClient('email_compose')
    // No same-provider fallback available — chain empty.
    const next = resolution.fallback?.()
    expect(next).toBeNull()
  })

  it('returns null from fallback() when same-provider chain is exhausted', () => {
    const tiers = {
      primary: mkTier({ model: 'claude-opus', provider: 'anthropic', fallback: 'secondary' }),
      secondary: mkTier({ model: 'claude-haiku', provider: 'anthropic', fallback: null }),
    }
    const configService = makeConfigService(tiers, { email_compose: 'primary' })
    const gateway = new LLMGatewayService(
      configService,
      makeDb().db,
      makeTemplateCache(),
      makeAnthropicClient(),
      null,
      null,
    )

    const resolution = gateway.resolveAgentClient('email_compose')
    const first = resolution.fallback?.()
    expect(first).not.toBeNull()
    expect(first!.tierKey).toBe('secondary')
    expect(first!.model).toBe('claude-haiku')
    // Second hop returns null — chain exhausted.
    const second = first!.fallback?.()
    expect(second).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// recordAgentCompletion()
// ---------------------------------------------------------------------------

describe('LLMGatewayService.recordAgentCompletion', () => {
  it('inserts a correctly-shaped row in ai_audit_log', async () => {
    const tiers = {
      t2_quality: mkTier({ model: 'claude-sonnet-4-6', provider: 'anthropic' }),
    }
    const configService = makeConfigService(tiers, { email_compose: 't2_quality' })
    const { db, inserts } = makeDb()
    const gateway = new LLMGatewayService(
      configService,
      db,
      makeTemplateCache(),
      makeAnthropicClient(),
      null,
      null,
    )

    await gateway.recordAgentCompletion('email_compose', 't2_quality', {
      iterations: 3,
      tokenUsage: { input: 1200, output: 450 },
      latencyMs: 8_700,
    })

    expect(inserts).toHaveLength(1)
    const row = inserts[0] as Record<string, unknown>
    expect(row.task_type).toBe('email_compose')
    expect(row.model).toBe('claude-sonnet-4-6')
    expect(row.prompt_tokens).toBe(1200)
    expect(row.completion_tokens).toBe(450)
    expect(row.total_tokens).toBe(1650)
    expect(row.duration_ms).toBe(8_700)
    expect(row.client_used).toBe('anthropic')
  })

  it('tolerates unknown tier keys without throwing', async () => {
    const configService = makeConfigService({}, {})
    const { db, inserts } = makeDb()
    const gateway = new LLMGatewayService(
      configService,
      db,
      makeTemplateCache(),
      makeAnthropicClient(),
      null,
      null,
    )

    await expect(
      gateway.recordAgentCompletion('some_task', 'missing_tier', {
        iterations: 1,
        tokenUsage: { input: 100, output: 100 },
        latencyMs: 1000,
      }),
    ).resolves.toBeUndefined()

    expect(inserts).toHaveLength(1)
    const row = inserts[0] as Record<string, unknown>
    expect(row.model).toBe('unknown')
  })
})
