import { describe, it, expect } from 'vitest'
import {
  ModelTierConfigSchema,
  ModelTierEntrySchema,
  ModelTiersConfigSchema,
  TaskRoutingConfigSchema,
  AIModelEntrySchema,
  AIConfigSchema,
} from '../config.js'
import type {
  AIClientType,
  ModelTierConfig,
  ModelTierEntry,
  ModelTiersConfig,
  TaskRoutingConfig,
  TaskName,
} from '../config.js'

describe('AIClientType', () => {
  it('accepts ollama as a client type in AIModelEntrySchema', () => {
    const result = AIModelEntrySchema.parse({
      model: 'gemma3:12b-it-q4_K_M',
      client: 'ollama',
    })
    expect(result.client).toBe('ollama')
  })

  it('accepts anthropic as a client type', () => {
    const result = AIModelEntrySchema.parse({
      model: 'claude-haiku-4-5-20250514',
      client: 'anthropic',
    })
    expect(result.client).toBe('anthropic')
  })

  it('accepts litellm as a client type', () => {
    const result = AIModelEntrySchema.parse({
      model: 'gpt-5.4',
      client: 'litellm',
    })
    expect(result.client).toBe('litellm')
  })

  it('defaults client to litellm when not specified', () => {
    const result = AIModelEntrySchema.parse({ model: 'gpt-5.4' })
    expect(result.client).toBe('litellm')
  })

  it('type-checks ollama in AIClientType union', () => {
    const t: AIClientType = 'ollama'
    expect(t).toBe('ollama')
  })
})

describe('ModelTierConfigSchema', () => {
  it('parses a valid T0 local tier config', () => {
    const tier = ModelTierConfigSchema.parse({
      provider: 'ollama',
      model: 'gemma3:12b-it-q4_K_M',
      base_url: 'http://ollama:11434/v1',
      max_completion_tokens: 256,
      timeout_ms: 10_000,
      fallback: 't1_fast',
    })
    expect(tier.provider).toBe('ollama')
    expect(tier.model).toBe('gemma3:12b-it-q4_K_M')
    expect(tier.base_url).toBe('http://ollama:11434/v1')
    expect(tier.max_completion_tokens).toBe(256)
    expect(tier.timeout_ms).toBe(10_000)
    expect(tier.fallback).toBe('t1_fast')
  })

  it('parses a tier with null fallback (top tier)', () => {
    const tier = ModelTierConfigSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250514',
      max_completion_tokens: 8192,
      timeout_ms: 30_000,
      fallback: null,
    })
    expect(tier.fallback).toBeNull()
    expect(tier.base_url).toBeUndefined()
  })

  it('allows base_url to be omitted', () => {
    const tier = ModelTierConfigSchema.parse({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20250514',
      max_completion_tokens: 4096,
      timeout_ms: 20_000,
      fallback: 't2_quality',
    })
    expect(tier.base_url).toBeUndefined()
  })

  it('rejects invalid provider', () => {
    expect(() =>
      ModelTierConfigSchema.parse({
        provider: 'invalid',
        model: 'foo',
        max_completion_tokens: 256,
        timeout_ms: 10_000,
        fallback: null,
      }),
    ).toThrow()
  })

  it('rejects missing required fields', () => {
    expect(() =>
      ModelTierConfigSchema.parse({
        provider: 'ollama',
        model: 'gemma3:12b-it-q4_K_M',
        // missing max_completion_tokens, timeout_ms
      }),
    ).toThrow()
  })

  it('defaults fallback to null when omitted', () => {
    const tier = ModelTierConfigSchema.parse({
      provider: 'ollama',
      model: 'gemma3:12b-it-q4_K_M',
      max_completion_tokens: 256,
      timeout_ms: 10_000,
    })
    expect(tier.fallback).toBeNull()
  })

  it('accepts openai and deepseek providers', () => {
    const openai = ModelTierEntrySchema.parse({
      provider: 'openai',
      model: 'gpt-4o',
      max_completion_tokens: 4096,
      timeout_ms: 20_000,
    })
    expect(openai.provider).toBe('openai')

    const deepseek = ModelTierEntrySchema.parse({
      provider: 'deepseek',
      model: 'deepseek-r1',
      max_completion_tokens: 8192,
      timeout_ms: 30_000,
    })
    expect(deepseek.provider).toBe('deepseek')
  })

  it('ModelTierConfigSchema is an alias for ModelTierEntrySchema', () => {
    expect(ModelTierConfigSchema).toBe(ModelTierEntrySchema)
  })
})

describe('ModelTierConfig / ModelTierEntry type alias', () => {
  it('types are interchangeable', () => {
    const entry: ModelTierEntry = {
      provider: 'ollama',
      model: 'gemma3:12b-it-q4_K_M',
      max_completion_tokens: 256,
      timeout_ms: 10_000,
      fallback: null,
    }
    const config: ModelTierConfig = entry
    expect(config.provider).toBe('ollama')
  })
})

describe('ModelTiersConfigSchema', () => {
  it('parses a full three-tier configuration', () => {
    const tiers: ModelTiersConfig = ModelTiersConfigSchema.parse({
      t0_local: {
        provider: 'ollama',
        model: 'gemma3:12b-it-q4_K_M',
        base_url: 'http://ollama:11434/v1',
        max_completion_tokens: 256,
        timeout_ms: 10_000,
        fallback: 't1_fast',
      },
      t1_fast: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20250514',
        max_completion_tokens: 4096,
        timeout_ms: 20_000,
        fallback: 't2_quality',
      },
      t2_quality: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        max_completion_tokens: 8192,
        timeout_ms: 30_000,
        fallback: null,
      },
    })
    expect(Object.keys(tiers)).toHaveLength(3)
    expect(tiers['t0_local']?.provider).toBe('ollama')
    expect(tiers['t1_fast']?.fallback).toBe('t2_quality')
    expect(tiers['t2_quality']?.fallback).toBeNull()
  })

  it('parses an empty tiers map', () => {
    const tiers = ModelTiersConfigSchema.parse({})
    expect(Object.keys(tiers)).toHaveLength(0)
  })
})

describe('TaskRoutingConfigSchema', () => {
  it('parses a task-to-tier routing map', () => {
    const routing: TaskRoutingConfig = TaskRoutingConfigSchema.parse({
      intent_classification: 't0_local',
      capture_classification: 't0_local',
      brain_view_classification: 't0_local',
      entity_extraction: 't1_fast',
      entity_linking: 't1_fast',
      synthesis: 't2_quality',
      governance: 't2_quality',
      weekly_brief: 't2_quality',
    })
    expect(routing['intent_classification']).toBe('t0_local')
    expect(routing['synthesis']).toBe('t2_quality')
    expect(Object.keys(routing)).toHaveLength(8)
  })

  it('parses an empty routing map', () => {
    const routing = TaskRoutingConfigSchema.parse({})
    expect(Object.keys(routing)).toHaveLength(0)
  })

  it('allows arbitrary task names (string keys)', () => {
    const routing = TaskRoutingConfigSchema.parse({
      custom_task: 't1_fast',
    })
    expect(routing['custom_task']).toBe('t1_fast')
  })
})

describe('TaskName type', () => {
  it('accepts known task names', () => {
    const task: TaskName = 'intent_classification'
    expect(task).toBe('intent_classification')
  })

  it('covers all expected task categories', () => {
    const tasks: TaskName[] = [
      'intent_classification',
      'capture_classification',
      'brain_view_classification',
      'voice_classification',
      'confidence_gating',
      'entity_extraction',
      'entity_linking',
      'capture_enrichment',
      'question_detection',
      'search_synthesis',
      'daily_sweep',
      'mcp_context',
      'auto_response_draft',
      'weekly_brief',
      'daily_connections',
      'drift_monitoring',
      'governance',
      'wiki_ingest',
      'wiki_synthesis',
    ]
    expect(tasks).toHaveLength(19)
  })
})

describe('AIConfigSchema with tier fields', () => {
  const baseConfig = {
    litellm_url: 'https://api.openai.com/v1',
    models: {
      fast: 'gpt-5.4',
      synthesis: 'gpt-5.4',
      governance: 'gpt-5.4',
      intent: 'gpt-5.4',
      embedding: 'text-embedding-3-large',
    },
    monthly_budget: { soft_limit_usd: 30, hard_limit_usd: 50 },
  }

  it('parses without model_tiers and task_routing (backward compat)', () => {
    const config = AIConfigSchema.parse(baseConfig)
    expect(config.model_tiers).toBeUndefined()
    expect(config.task_routing).toBeUndefined()
  })

  it('parses with model_tiers and task_routing', () => {
    const config = AIConfigSchema.parse({
      ...baseConfig,
      model_tiers: {
        t0_local: {
          provider: 'ollama',
          model: 'gemma3:12b-it-q4_K_M',
          max_completion_tokens: 256,
          timeout_ms: 10_000,
          fallback: 't1_fast',
        },
        t1_fast: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20250514',
          max_completion_tokens: 4096,
          timeout_ms: 20_000,
          fallback: null,
        },
      },
      task_routing: {
        intent_classification: 't0_local',
        synthesis: 't1_fast',
      },
    })
    expect(config.model_tiers).toBeDefined()
    expect(config.model_tiers!['t0_local']?.provider).toBe('ollama')
    expect(config.task_routing).toBeDefined()
    expect(config.task_routing!['intent_classification']).toBe('t0_local')
  })
})
