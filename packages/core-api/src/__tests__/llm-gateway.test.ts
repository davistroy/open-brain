import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LLMGatewayService, LLMBudgetExceededError, LLMGatewayError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeOpenAIClient(response = 'LiteLLM response') {
  return {
    apiKey: 'test-key',
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: response } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      },
    },
  } as any
}

function makeAnthropicClient(response = 'Anthropic response') {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: response }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    },
  } as any
}

function makeOllamaClient(response = 'Ollama response') {
  return {
    apiKey: 'ollama',
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: response } }],
          usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
        }),
      },
    },
  } as any
}

function makeDb() {
  const insertValues = vi.fn().mockResolvedValue(undefined)
  return {
    insert: vi.fn().mockReturnValue({ values: insertValues }),
    _insertValues: insertValues,
  } as any
}

function makeTemplateCache() {
  return {
    render: vi.fn().mockReturnValue('rendered prompt'),
  } as any
}

/** Builds a ConfigService mock with three-tier routing configured */
function makeConfigService(overrides: Record<string, unknown> = {}) {
  const defaults = {
    litellm_url: 'https://api.openai.com/v1',
    models: {
      fast: { model: 'claude-sonnet-4-20250514', client: 'anthropic', cost_per_1k_input: 0, cost_per_1k_output: 0 },
      synthesis: { model: 'claude-sonnet-4-20250514', client: 'anthropic', cost_per_1k_input: 0, cost_per_1k_output: 0 },
      governance: { model: 'claude-sonnet-4-20250514', client: 'anthropic', cost_per_1k_input: 0, cost_per_1k_output: 0 },
      intent: { model: 'claude-sonnet-4-20250514', client: 'anthropic', cost_per_1k_input: 0, cost_per_1k_output: 0 },
      embedding: { model: 'text-embedding-3-large', client: 'litellm', cost_per_1k_input: 0.00013, cost_per_1k_output: 0 },
    },
    model_tiers: {
      t0_local: {
        provider: 'ollama',
        model: 'gemma4:12b-q4_K_M',
        base_url: 'http://ollama:11434/v1',
        max_completion_tokens: 256,
        timeout_ms: 10000,
        fallback: 't1_fast',
      },
      t1_fast: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        max_completion_tokens: 4096,
        timeout_ms: 20000,
        fallback: 't2_quality',
      },
      t2_quality: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        max_completion_tokens: 8192,
        timeout_ms: 30000,
        fallback: null,
      },
    },
    task_routing: {
      intent_classification: 't0_local',
      entity_extraction: 't1_fast',
      governance: 't2_quality',
    },
    monthly_budget: {
      soft_limit_usd: 20,
      hard_limit_usd: 35,
    },
    ...overrides,
  }

  const modelTiers = defaults.model_tiers as Record<string, unknown>
  const taskRouting = defaults.task_routing as Record<string, string>

  return {
    get: vi.fn().mockReturnValue(defaults),
    getModelTier: vi.fn().mockImplementation((key: string) => modelTiers[key] ?? undefined),
    getTaskTier: vi.fn().mockImplementation((task: string) => {
      const tierKey = taskRouting[task]
      return tierKey ? modelTiers[tierKey] : undefined
    }),
    getTaskTierKey: vi.fn().mockImplementation((task: string) => taskRouting[task] ?? undefined),
    getTaskRouting: vi.fn().mockReturnValue(taskRouting),
    hasThreeTierRouting: vi.fn().mockReturnValue(true),
    getMonthlyBudget: vi.fn().mockReturnValue(defaults.monthly_budget),
  } as any
}

// ---------------------------------------------------------------------------
// Tests: Constructor and client detection
// ---------------------------------------------------------------------------

describe('LLMGatewayService', () => {
  let db: ReturnType<typeof makeDb>
  let templateCache: ReturnType<typeof makeTemplateCache>

  beforeEach(() => {
    db = makeDb()
    templateCache = makeTemplateCache()
  })

  describe('constructor', () => {
    it('logs all available clients', () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient()
      const ollama = makeOllamaClient()

      // Should not throw
      const gw = new LLMGatewayService(litellm, makeConfigService(), db, templateCache, anthropic, ollama)
      expect(gw).toBeDefined()
    })

    it('works with only litellm client', () => {
      const litellm = makeOpenAIClient()
      const gw = new LLMGatewayService(litellm, makeConfigService(), db, templateCache, null, null)
      expect(gw).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: resolveByTask
  // ---------------------------------------------------------------------------

  describe('resolveByTask', () => {
    it('resolves T0 task to Ollama when Ollama client is available', () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, ollama)
      const result = gw.resolveByTask('intent_classification')

      expect(result).not.toBeNull()
      expect(result!.client).toBe('ollama')
      expect(result!.model).toBe('gemma4:12b-q4_K_M')
      expect(result!.tierKey).toBe('t0_local')
      expect(result!.maxTokens).toBe(256)
      expect(result!.timeoutMs).toBe(10000)
    })

    it('degrades T0 task to litellm when Ollama client is not available', () => {
      const litellm = makeOpenAIClient()
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, null)
      const result = gw.resolveByTask('intent_classification')

      expect(result).not.toBeNull()
      expect(result!.client).toBe('litellm')
      expect(result!.model).toBe('gemma4:12b-q4_K_M')
    })

    it('resolves T1 task to Anthropic', () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient()
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, null)
      const result = gw.resolveByTask('entity_extraction')

      expect(result).not.toBeNull()
      expect(result!.client).toBe('anthropic')
      expect(result!.model).toBe('claude-haiku-4-5-20251001')
      expect(result!.tierKey).toBe('t1_fast')
    })

    it('resolves T2 task to Anthropic', () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient()
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, null)
      const result = gw.resolveByTask('governance')

      expect(result).not.toBeNull()
      expect(result!.client).toBe('anthropic')
      expect(result!.model).toBe('claude-sonnet-4-6')
      expect(result!.tierKey).toBe('t2_quality')
    })

    it('returns null for unknown task', () => {
      const litellm = makeOpenAIClient()
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, null)
      const result = gw.resolveByTask('nonexistent_task')

      expect(result).toBeNull()
    })

    it('returns null when three-tier routing is not configured', () => {
      const litellm = makeOpenAIClient()
      const config = makeConfigService()
      config.hasThreeTierRouting.mockReturnValue(false)

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, null)
      const result = gw.resolveByTask('intent_classification')

      expect(result).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: completeByTask — happy path
  // ---------------------------------------------------------------------------

  describe('completeByTask', () => {
    it('routes T0 task to Ollama and returns response', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient('classified: idea')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, ollama)
      const result = await gw.completeByTask('Classify this.', 'intent_classification')

      expect(result).toBe('classified: idea')
      expect(ollama.chat.completions.create).toHaveBeenCalledOnce()
      // LiteLLM should NOT have been called
      expect(litellm.chat.completions.create).not.toHaveBeenCalled()
    })

    it('routes T1 task to Anthropic and returns response', async () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient('entities found')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, null)
      const result = await gw.completeByTask('Extract entities.', 'entity_extraction')

      expect(result).toBe('entities found')
      expect(anthropic.messages.create).toHaveBeenCalledOnce()
    })

    it('routes T2 task to Anthropic and returns response', async () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient('governance assessment')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, null)
      const result = await gw.completeByTask('Governance prompt.', 'governance')

      expect(result).toBe('governance assessment')
      expect(anthropic.messages.create).toHaveBeenCalledOnce()
    })

    it('throws LLMGatewayError when three-tier routing is not configured', async () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient('legacy response')
      const config = makeConfigService()
      config.hasThreeTierRouting.mockReturnValue(false)

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, null)

      await expect(gw.completeByTask('Some prompt.', 'intent_classification'))
        .rejects.toThrow(LLMGatewayError)
      await expect(gw.completeByTask('Some prompt.', 'intent_classification'))
        .rejects.toThrow(/has no routing entry/)
      // Legacy alias path must not be taken
      expect(anthropic.messages.create).not.toHaveBeenCalled()
    })

    it('throws LLMGatewayError when task has no routing entry', async () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient()
      const ollama = makeOllamaClient()
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)

      await expect(gw.completeByTask('Test.', 'unregistered_task_xyz'))
        .rejects.toThrow(LLMGatewayError)
      await expect(gw.completeByTask('Test.', 'unregistered_task_xyz'))
        .rejects.toThrow(/has no routing entry/)
      // No client should have been called
      expect(anthropic.messages.create).not.toHaveBeenCalled()
      expect(ollama.chat.completions.create).not.toHaveBeenCalled()
      expect(litellm.chat.completions.create).not.toHaveBeenCalled()
    })

    it('logs audit entry on success', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient('ok')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, ollama)
      await gw.completeByTask('Test.', 'intent_classification')

      expect(db.insert).toHaveBeenCalled()
      const values = db._insertValues.mock.calls[0][0]
      expect(values.task_type).toBe('intent_classification')
      expect(values.client_used).toBe('ollama')
      expect(values.model).toBe('gemma4:12b-q4_K_M')
      expect(values.error).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: Tier fallback chain
  // ---------------------------------------------------------------------------

  describe('tier fallback chain', () => {
    it('falls back from T0 (Ollama) to T1 (Anthropic) on timeout', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValueOnce(new Error('ETIMEDOUT'))
      const anthropic = makeAnthropicClient('fallback T1 response')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const result = await gw.completeByTask('Test.', 'intent_classification')

      expect(result).toBe('fallback T1 response')
      expect(ollama.chat.completions.create).toHaveBeenCalledOnce()
      expect(anthropic.messages.create).toHaveBeenCalledOnce()
    })

    it('falls back from T0 to T1 on 500 error', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValueOnce(new Error('500 Internal Server Error'))
      const anthropic = makeAnthropicClient('T1 response')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const result = await gw.completeByTask('Test.', 'intent_classification')

      expect(result).toBe('T1 response')
    })

    it('falls back from T0 to T1 on ECONNREFUSED', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const anthropic = makeAnthropicClient('T1 fallback')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const result = await gw.completeByTask('Test.', 'intent_classification')

      expect(result).toBe('T1 fallback')
    })

    it('falls back T0 -> T1 -> T2 (two hops) when both fail', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValueOnce(new Error('ETIMEDOUT'))
      const anthropic = makeAnthropicClient()
      // First call (T1 Haiku) fails, second call (T2 Sonnet) succeeds
      anthropic.messages.create
        .mockRejectedValueOnce(new Error('429 rate limit'))
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'T2 fallback response' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        })
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const result = await gw.completeByTask('Test.', 'intent_classification')

      expect(result).toBe('T2 fallback response')
      expect(ollama.chat.completions.create).toHaveBeenCalledOnce() // T0 tried
      expect(anthropic.messages.create).toHaveBeenCalledTimes(2) // T1 + T2 tried
    })

    it('enforces max 2 hops — does not attempt T3 after T0->T1->T2 all fail', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValue(new Error('ETIMEDOUT'))
      const anthropic = makeAnthropicClient()
      // Both T1 and T2 fail
      anthropic.messages.create
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)

      await expect(gw.completeByTask('Test.', 'intent_classification'))
        .rejects.toThrow(LLMGatewayError)

      // T0 (Ollama) + T1 (Anthropic) + T2 (Anthropic) = 1 + 2 = 3 calls total
      expect(ollama.chat.completions.create).toHaveBeenCalledOnce()
      expect(anthropic.messages.create).toHaveBeenCalledTimes(2)
    })

    it('does not fallback on non-transient errors (e.g. 400 client error)', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValue(new Error('400 Bad Request: invalid model'))
      const anthropic = makeAnthropicClient('should not reach')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)

      await expect(gw.completeByTask('Test.', 'intent_classification'))
        .rejects.toThrow(LLMGatewayError)

      // No fallback attempted
      expect(anthropic.messages.create).not.toHaveBeenCalled()
    })

    it('does not fallback when tier has no fallback configured (T2)', async () => {
      const litellm = makeOpenAIClient()
      const anthropic = makeAnthropicClient()
      anthropic.messages.create.mockRejectedValue(new Error('500 Internal Server Error'))
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, null)

      await expect(gw.completeByTask('Test.', 'governance'))
        .rejects.toThrow(LLMGatewayError)
    })

    it('logs audit entries for both failed primary and successful fallback', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValueOnce(new Error('ETIMEDOUT'))
      const anthropic = makeAnthropicClient('fallback ok')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      await gw.completeByTask('Test.', 'intent_classification')

      // Should have 2 audit log entries: failed T0 + successful T1
      expect(db._insertValues).toHaveBeenCalledTimes(2)

      const firstCall = db._insertValues.mock.calls[0][0]
      expect(firstCall.client_used).toBe('ollama')
      expect(firstCall.error).toContain('ETIMEDOUT')

      const secondCall = db._insertValues.mock.calls[1][0]
      expect(secondCall.client_used).toBe('anthropic')
      expect(secondCall.error).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: "Loading model" same-tier retry backoff (A58)
  // ---------------------------------------------------------------------------

  describe('model-loading same-tier retry', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('retries the same tier on "Loading model" 503 and succeeds without fallback', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient('warm response')
      ollama.chat.completions.create
        .mockRejectedValueOnce(new Error('503 Loading model'))
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'warm response' } }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        })
      const anthropic = makeAnthropicClient('should not be called')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const resultPromise = gw.completeByTask('Test.', 'intent_classification')

      // Advance past the first backoff (3000ms) so the retry fires
      await vi.advanceTimersByTimeAsync(3_500)

      const result = await resultPromise

      expect(result).toBe('warm response')
      expect(ollama.chat.completions.create).toHaveBeenCalledTimes(2)
      expect(anthropic.messages.create).not.toHaveBeenCalled()
    })

    it('falls back to next tier after 3 same-tier retries all return "Loading model"', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValue(new Error('503 Loading model'))
      const anthropic = makeAnthropicClient('T1 response after T0 exhausted retries')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const resultPromise = gw.completeByTask('Test.', 'intent_classification')

      // 3 retries: 3s + 6s + 12s = 21s total backoff
      await vi.advanceTimersByTimeAsync(21_500)

      const result = await resultPromise

      expect(result).toBe('T1 response after T0 exhausted retries')
      expect(ollama.chat.completions.create).toHaveBeenCalledTimes(4) // initial + 3 retries
      expect(anthropic.messages.create).toHaveBeenCalledOnce()
    })

    it('does NOT retry same tier on generic 503 (only on "Loading model")', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValueOnce(new Error('503 Service Unavailable'))
      const anthropic = makeAnthropicClient('T1 took over immediately')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const result = await gw.completeByTask('Test.', 'intent_classification')

      // No timer advancement needed — fallback should be synchronous
      expect(result).toBe('T1 took over immediately')
      expect(ollama.chat.completions.create).toHaveBeenCalledOnce()
      expect(anthropic.messages.create).toHaveBeenCalledOnce()
    })

    it('does NOT retry same tier on ECONNREFUSED (falls back immediately)', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient()
      ollama.chat.completions.create.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      const anthropic = makeAnthropicClient('T1 fallback')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, anthropic, ollama)
      const result = await gw.completeByTask('Test.', 'intent_classification')

      expect(result).toBe('T1 fallback')
      expect(ollama.chat.completions.create).toHaveBeenCalledOnce()
    })

    it('matches "model is loading" variant (vLLM-style)', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient('warm response')
      ollama.chat.completions.create
        .mockRejectedValueOnce(new Error('503 model is loading'))
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'warm response' } }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        })
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, ollama)
      const resultPromise = gw.completeByTask('Test.', 'intent_classification')
      await vi.advanceTimersByTimeAsync(3_500)

      const result = await resultPromise
      expect(result).toBe('warm response')
      expect(ollama.chat.completions.create).toHaveBeenCalledTimes(2)
    })

    it('logs each retry attempt as a separate audit entry', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient('warm')
      ollama.chat.completions.create
        .mockRejectedValueOnce(new Error('503 Loading model'))
        .mockRejectedValueOnce(new Error('503 Loading model'))
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'warm' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, ollama)
      const p = gw.completeByTask('Test.', 'intent_classification')
      await vi.advanceTimersByTimeAsync(3_500)  // after first backoff
      await vi.advanceTimersByTimeAsync(6_500)  // after second backoff

      await p

      // 2 failed attempts + 1 successful attempt
      expect(db._insertValues).toHaveBeenCalledTimes(3)
      expect(db._insertValues.mock.calls[0][0].error).toContain('Loading model')
      expect(db._insertValues.mock.calls[1][0].error).toContain('Loading model')
      expect(db._insertValues.mock.calls[2][0].error).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: Budget checks with Ollama (should skip)
  // ---------------------------------------------------------------------------

  describe('budget checks', () => {
    it('skips budget check for Ollama calls (local, free)', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient('local response')
      const config = makeConfigService()

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, ollama)

      // Even if getMonthlySpend would exceed limits, Ollama calls should succeed
      // since budget check is skipped for Ollama
      const result = await gw.completeByTask('Test.', 'intent_classification')
      expect(result).toBe('local response')
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: Legacy complete() method with Ollama
  // ---------------------------------------------------------------------------

  describe('legacy complete() with ollama client', () => {
    it('routes to Ollama when model alias has client: ollama', async () => {
      const litellm = makeOpenAIClient()
      const ollama = makeOllamaClient('ollama legacy response')
      const config = makeConfigService()
      // Override model config so 'fast' alias uses ollama client
      const aiConfig = config.get('ai')
      aiConfig.models.fast = { model: 'gemma4:12b', client: 'ollama', cost_per_1k_input: 0, cost_per_1k_output: 0 }

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, ollama)
      const result = await gw.complete('Test.', 'fast')

      expect(result).toBe('ollama legacy response')
      expect(ollama.chat.completions.create).toHaveBeenCalledOnce()
      expect(litellm.chat.completions.create).not.toHaveBeenCalled()
    })

    it('falls back to litellm when ollama client is null but model alias specifies ollama', async () => {
      const litellm = makeOpenAIClient('litellm fallback')
      const config = makeConfigService()
      const aiConfig = config.get('ai')
      aiConfig.models.fast = { model: 'gemma4:12b', client: 'ollama', cost_per_1k_input: 0, cost_per_1k_output: 0 }

      const gw = new LLMGatewayService(litellm, config, db, templateCache, null, null)
      const result = await gw.complete('Test.', 'fast')

      expect(result).toBe('litellm fallback')
      expect(litellm.chat.completions.create).toHaveBeenCalledOnce()
    })
  })
})
