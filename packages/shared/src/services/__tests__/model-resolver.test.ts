import { describe, it, expect } from 'vitest'
import type { AIConfig } from '../../types/config.js'
import { resolveTaskModel, ModelResolverError } from '../model-resolver.js'

/**
 * Build a minimal AIConfig fixture for resolver tests. Only the fields the
 * resolver touches matter; the rest are filled with the schema's required
 * defaults so the object type-checks.
 */
function makeConfig(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    models: {
      fast: { model: 'gpt-5.4', max_completion_tokens: 1024, timeout_ms: 30_000 },
      synthesis: { model: 'gpt-5.4', max_completion_tokens: 4096, timeout_ms: 60_000 },
      governance: { model: 'gpt-5.4', max_completion_tokens: 4096, timeout_ms: 60_000 },
      intent: { model: 'gpt-5.4', max_completion_tokens: 256, timeout_ms: 10_000 },
      embedding: { model: 'text-embedding-3-large', dimensions: 768 },
    },
    monthly_budget: { soft_limit_usd: 30, hard_limit_usd: 50 },
    ...overrides,
  } as AIConfig
}

describe('resolveTaskModel', () => {
  it('resolves a known task alias to its tier model (happy path)', () => {
    const config = makeConfig({
      task_routing: { email_compose: 't2_quality' },
      model_tiers: {
        t2_quality: {
          model: 'claude-sonnet-4-6',
          max_completion_tokens: 4096,
          timeout_ms: 60_000,
          fallback: null,
          provider: 'openai',
        },
      },
    })

    const result = resolveTaskModel(config, 'email_compose')

    expect(result).toEqual({ model: 'claude-sonnet-4-6', tierKey: 't2_quality' })
  })

  it('resolves multiple aliases pointing to the same tier independently', () => {
    const config = makeConfig({
      task_routing: {
        email_compose: 't2_quality',
        search_synthesis: 't2_quality',
        entity_extraction: 't1_fast',
      },
      model_tiers: {
        t2_quality: {
          model: 'claude-sonnet-4-6',
          max_completion_tokens: 4096,
          timeout_ms: 60_000,
          fallback: null,
          provider: 'openai',
        },
        t1_fast: {
          model: 'gpt-5.4',
          max_completion_tokens: 1024,
          timeout_ms: 30_000,
          fallback: null,
          provider: 'openai',
        },
      },
    })

    expect(resolveTaskModel(config, 'email_compose').model).toBe('claude-sonnet-4-6')
    expect(resolveTaskModel(config, 'search_synthesis').model).toBe('claude-sonnet-4-6')
    expect(resolveTaskModel(config, 'search_synthesis').tierKey).toBe('t2_quality')
    expect(resolveTaskModel(config, 'entity_extraction').model).toBe('gpt-5.4')
    expect(resolveTaskModel(config, 'entity_extraction').tierKey).toBe('t1_fast')
  })

  it('throws ModelResolverError with known-alias list when task is unknown', () => {
    const config = makeConfig({
      task_routing: { email_compose: 't2_quality', entity_extraction: 't1_fast' },
      model_tiers: {
        t2_quality: {
          model: 'claude-sonnet-4-6',
          max_completion_tokens: 4096,
          timeout_ms: 60_000,
          fallback: null,
          provider: 'openai',
        },
        t1_fast: {
          model: 'gpt-5.4',
          max_completion_tokens: 1024,
          timeout_ms: 30_000,
          fallback: null,
          provider: 'openai',
        },
      },
    })

    expect(() => resolveTaskModel(config, 'not_a_real_task')).toThrowError(ModelResolverError)

    try {
      resolveTaskModel(config, 'not_a_real_task')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelResolverError)
      const msg = (err as Error).message
      expect(msg).toContain("Unknown task alias 'not_a_real_task'")
      expect(msg).toContain('email_compose')
      expect(msg).toContain('entity_extraction')
      expect((err as ModelResolverError).taskName).toBe('not_a_real_task')
    }
  })

  it('throws ModelResolverError naming both task and missing tier when tier is undefined', () => {
    const config = makeConfig({
      task_routing: { email_compose: 't2_quality' },
      model_tiers: {
        t1_fast: {
          model: 'gpt-5.4',
          max_completion_tokens: 1024,
          timeout_ms: 30_000,
          fallback: null,
          provider: 'openai',
        },
      },
    })

    try {
      resolveTaskModel(config, 'email_compose')
      expect.fail('expected ModelResolverError')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelResolverError)
      const msg = (err as Error).message
      expect(msg).toContain('email_compose')
      expect(msg).toContain('t2_quality')
      expect(msg).toContain('t1_fast') // the known-tiers list
      expect((err as ModelResolverError).taskName).toBe('email_compose')
    }
  })

  it('throws ModelResolverError when task_routing is missing entirely', () => {
    const config = makeConfig({
      model_tiers: {
        t1_fast: {
          model: 'gpt-5.4',
          max_completion_tokens: 1024,
          timeout_ms: 30_000,
          fallback: null,
          provider: 'openai',
        },
      },
    })

    try {
      resolveTaskModel(config, 'email_compose')
      expect.fail('expected ModelResolverError')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelResolverError)
      expect((err as Error).message).toContain("task_routing")
    }
  })

  it('throws ModelResolverError when model_tiers is missing entirely', () => {
    const config = makeConfig({
      task_routing: { email_compose: 't2_quality' },
    })

    try {
      resolveTaskModel(config, 'email_compose')
      expect.fail('expected ModelResolverError')
    } catch (err) {
      expect(err).toBeInstanceOf(ModelResolverError)
      expect((err as Error).message).toContain('model_tiers')
    }
  })

  it('includes empty known-aliases list sentinel when task_routing is empty object', () => {
    const config = makeConfig({
      task_routing: {},
      model_tiers: {
        t1_fast: {
          model: 'gpt-5.4',
          max_completion_tokens: 1024,
          timeout_ms: 30_000,
          fallback: null,
          provider: 'openai',
        },
      },
    })

    try {
      resolveTaskModel(config, 'email_compose')
      expect.fail('expected ModelResolverError')
    } catch (err) {
      expect((err as Error).message).toContain('(none)')
    }
  })
})
