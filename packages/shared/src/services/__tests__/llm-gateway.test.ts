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
    api_key_env: overrides.api_key_env,
    max_completion_tokens: overrides.max_completion_tokens ?? 4096,
    timeout_ms: overrides.timeout_ms ?? 60_000,
    fallback: overrides.fallback ?? null,
    // Cost fields: undefined by default (ollama/local path); callers may set explicit values.
    cost_per_1k_input: overrides.cost_per_1k_input,
    cost_per_1k_output: overrides.cost_per_1k_output,
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

  // -------------------------------------------------------------------------
  // #283 — openai_compat tier auth.
  //
  // The Jetson added a bearer requirement on /chat/completions and the gateway
  // kept sending a hardcoded apiKey:'local' ("local endpoints ignore the key").
  // Result: 401 on 100% of T1 calls for two weeks, invisible because a totally
  // failing FREE tier looks exactly like an idle one (cost stays $0, and
  // /v1/models still answers 200 unauthenticated).
  //
  // getClientForTier is private; reached via bracket access because the apiKey it
  // puts on the client IS the behaviour under test.
  // -------------------------------------------------------------------------
  function clientFor(tier: ModelTierEntry, tierKey: string): { apiKey: string } {
    const gateway = new LLMGatewayService(
      makeConfigService({ [tierKey]: tier }, {}),
      makeDb().db,
      makeTemplateCache(),
      makeAnthropicClient(),
      null,
      null,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (gateway as any).getClientForTier(tier, tierKey, 'openai') as { apiKey: string }
  }

  it('sends the tier api_key_env value as the bearer key (#283)', () => {
    process.env.TEST_JETSON_KEY_283 = 'sk-jetson-secret'
    const tier = mkTier({
      model: 'qwen3.5-4b',
      provider: 'openai_compat',
      base_url: 'http://jetson:8080/v1',
      api_key_env: 'TEST_JETSON_KEY_283',
    })

    expect(clientFor(tier, 't1_jetson_withkey').apiKey).toBe('sk-jetson-secret')
    delete process.env.TEST_JETSON_KEY_283
  })

  it("falls back to 'local' when a tier declares api_key_env but it is unset (#283)", () => {
    delete process.env.TEST_MISSING_KEY_283
    const tier = mkTier({
      model: 'qwen3.5-4b',
      provider: 'openai_compat',
      base_url: 'http://jetson:8080/v1',
      api_key_env: 'TEST_MISSING_KEY_283',
    })

    // Still constructs (the SDK requires a non-empty key) — the gateway warns
    // rather than throwing, so an unset key degrades exactly like before instead
    // of taking the process down.
    expect(clientFor(tier, 't1_jetson_nokey').apiKey).toBe('local')
  })

  it("keeps 'local' for keyless openai_compat tiers that declare no api_key_env (#283)", () => {
    // Spark is genuinely keyless today (0 errors in ai_audit_log) — this pins
    // that the fix's blast radius is only tiers that opt in.
    const tier = mkTier({
      model: 'qwen-35b',
      provider: 'openai_compat',
      base_url: 'http://spark:8000',
    })

    expect(clientFor(tier, 't1_spark_keyless').apiKey).toBe('local')
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

// ---------------------------------------------------------------------------
// estimateTierCostUsd() — tested indirectly via recordAgentCompletion audit row
// ---------------------------------------------------------------------------

describe('estimateTierCostUsd (via recordAgentCompletion)', () => {
  it('A: paid-provider tier with non-zero costs produces correct cost_usd', async () => {
    // anthropic tier: $0.003/1k input, $0.015/1k output
    // input=1000 tokens → $0.003; output=500 tokens → $0.0075; total = $0.0105
    const tiers = {
      t2_quality: mkTier({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        cost_per_1k_input: 0.003,
        cost_per_1k_output: 0.015,
      }),
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
      iterations: 1,
      tokenUsage: { input: 1000, output: 500 },
      latencyMs: 1000,
    })

    expect(inserts).toHaveLength(1)
    const row = inserts[0] as Record<string, unknown>
    expect(Number(row.cost_usd)).toBeCloseTo(0.0105, 6)
  })

  it('B: openai_compat tier with explicit 0/0 costs produces cost_usd === 0', async () => {
    // Jetson/Spark — free endpoint, explicitly configured as 0
    const tiers = {
      t1_jetson: mkTier({
        model: 'qwen-4b',
        provider: 'openai_compat',
        base_url: 'http://jetson:8080',
        cost_per_1k_input: 0,
        cost_per_1k_output: 0,
      }),
    }
    const configService = makeConfigService(tiers, { intent: 't1_jetson' })
    const { db, inserts } = makeDb()
    const gateway = new LLMGatewayService(
      configService,
      db,
      makeTemplateCache(),
      null,
      null,
      null,
    )

    await gateway.recordAgentCompletion('intent', 't1_jetson', {
      iterations: 1,
      tokenUsage: { input: 500, output: 100 },
      latencyMs: 500,
    })

    expect(inserts).toHaveLength(1)
    const row = inserts[0] as Record<string, unknown>
    expect(Number(row.cost_usd)).toBe(0)
  })

  it('C: ollama tier with undefined cost fields produces cost_usd === 0', async () => {
    // ollama: no cost fields in config (local free inference)
    const tiers = {
      t0_local: mkTier({
        model: 'gemma3-4b',
        provider: 'ollama',
        // cost_per_1k_input and cost_per_1k_output intentionally omitted (undefined)
      }),
    }
    const configService = makeConfigService(tiers, { quick: 't0_local' })
    const { db, inserts } = makeDb()
    const gateway = new LLMGatewayService(
      configService,
      db,
      makeTemplateCache(),
      null,
      null,
      null,
    )

    await gateway.recordAgentCompletion('quick', 't0_local', {
      iterations: 1,
      tokenUsage: { input: 200, output: 50 },
      latencyMs: 200,
    })

    expect(inserts).toHaveLength(1)
    const row = inserts[0] as Record<string, unknown>
    expect(Number(row.cost_usd)).toBe(0)
  })
})
