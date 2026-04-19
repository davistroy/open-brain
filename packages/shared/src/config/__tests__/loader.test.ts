import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigService } from '../loader.js'

// Path to the real production ai-routing.yaml (5 levels up from __tests__)
const PROD_AI_ROUTING = resolve(__dirname, '../../../../../config/ai-routing.yaml')

function makeTmpDir(): string {
  const dir = join(tmpdir(), `open-brain-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const validBrainViews = `
views:
  - name: career
    description: Career stuff
  - name: personal
    description: Personal stuff
`

const validPipeline = `
stages:
  - name: classify
    enabled: true
retry:
  max_attempts: 3
  backoff_ms: [1000, 5000]
`

const validAi = `
litellm_url: "https://llm.k4jda.net"
models:
  fast:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  synthesis:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  governance:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  intent:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
monthly_budget:
  soft_limit_usd: 30
  hard_limit_usd: 50
`

const validNotifications = `
pushover:
  enabled: false
weekly_brief:
  enabled: true
`

function writeValidConfigs(dir: string): void {
  writeFileSync(join(dir, 'brain-views.yaml'), validBrainViews)
  writeFileSync(join(dir, 'pipeline.yaml'), validPipeline)
  writeFileSync(join(dir, 'ai-routing.yaml'), validAi)
  writeFileSync(join(dir, 'notifications.yaml'), validNotifications)
}

describe('ConfigService', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('loads valid config without errors', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    expect(() => service.load()).not.toThrow()
  })

  it('throws on startup if a config file is missing', () => {
    // Only write 3 of 4 files
    writeFileSync(join(tmpDir, 'brain-views.yaml'), validBrainViews)
    writeFileSync(join(tmpDir, 'pipeline.yaml'), validPipeline)
    writeFileSync(join(tmpDir, 'ai-routing.yaml'), validAi)
    // Missing notifications.yaml
    const service = new ConfigService(tmpDir)
    expect(() => service.load()).toThrow()
  })

  it('throws on startup if YAML is invalid', () => {
    writeValidConfigs(tmpDir)
    writeFileSync(join(tmpDir, 'brain-views.yaml'), 'invalid: yaml: [unclosed')
    const service = new ConfigService(tmpDir)
    expect(() => service.load()).toThrow()
  })

  it('getBrainViews returns view names', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    service.load()
    expect(service.getBrainViews()).toEqual(['career', 'personal'])
  })

  it('reload keeps previous config on failure', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    service.load()

    // Break one config file
    writeFileSync(join(tmpDir, 'brain-views.yaml'), 'invalid: [unclosed')
    const results = service.reload()

    const failed = results.find(r => r.file === 'brain-views.yaml')
    expect(failed?.success).toBe(false)
    expect(failed?.error).toBeTruthy()

    // Previous config still works
    expect(service.getBrainViews()).toEqual(['career', 'personal'])
  })

  it('getNotificationsConfig returns parsed notifications config', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    service.load()
    const config = service.getNotificationsConfig()
    expect(config.pushover.enabled).toBe(false)
    expect(config.weekly_brief.enabled).toBe(true)
    expect(config.weekly_brief.cron).toBe('0 8 * * 1')
  })

  it('reload reloads notifications.yaml', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    service.load()
    expect(service.getNotificationsConfig().pushover.enabled).toBe(false)

    // Update notifications.yaml
    writeFileSync(join(tmpDir, 'notifications.yaml'), `
pushover:
  enabled: true
weekly_brief:
  enabled: false
`)
    const results = service.reload()
    const notifResult = results.find(r => r.file === 'notifications.yaml')
    expect(notifResult?.success).toBe(true)
    expect(service.getNotificationsConfig().pushover.enabled).toBe(true)
    expect(service.getNotificationsConfig().weekly_brief.enabled).toBe(false)
  })

  it('throws if get() called before load()', () => {
    const service = new ConfigService(tmpDir)
    expect(() => service.get('brainViews')).toThrow('not loaded')
  })

  // ================================================================
  // Three-tier model routing tests
  // ================================================================

  describe('three-tier routing', () => {
    const validAiWithTiers = `
litellm_url: "https://api.openai.com/v1"
models:
  fast:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  synthesis:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  governance:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  intent:
    model: claude-sonnet-4-20250514
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t0_local:
    provider: ollama
    model: "gemma4:12b-q4_K_M"
    base_url: "http://ollama:11434/v1"
    max_completion_tokens: 256
    timeout_ms: 10000
    fallback: t1_fast
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_input: 0.0008
    cost_per_1k_output: 0.004
    fallback: t2_quality
  t2_quality:
    provider: anthropic
    model: "claude-sonnet-4-6"
    max_completion_tokens: 8192
    timeout_ms: 30000
    cost_per_1k_input: 0.003
    cost_per_1k_output: 0.015
    fallback: null
task_routing:
  intent_classification: t0_local
  capture_classification: t0_local
  entity_extraction: t1_fast
  governance: t2_quality
  weekly_brief: t2_quality
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`

    function writeThreeTierConfigs(dir: string): void {
      writeFileSync(join(dir, 'brain-views.yaml'), validBrainViews)
      writeFileSync(join(dir, 'pipeline.yaml'), validPipeline)
      writeFileSync(join(dir, 'ai-routing.yaml'), validAiWithTiers)
      writeFileSync(join(dir, 'notifications.yaml'), validNotifications)
    }

    it('loads config with model_tiers and task_routing', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).not.toThrow()
    })

    it('getModelTier returns correct tier entry', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()

      const t0 = service.getModelTier('t0_local')
      expect(t0).toBeDefined()
      expect(t0!.provider).toBe('ollama')
      expect(t0!.model).toBe('gemma4:12b-q4_K_M')
      expect(t0!.max_completion_tokens).toBe(256)
      expect(t0!.timeout_ms).toBe(10000)
      expect(t0!.fallback).toBe('t1_fast')

      const t2 = service.getModelTier('t2_quality')
      expect(t2).toBeDefined()
      expect(t2!.provider).toBe('anthropic')
      expect(t2!.fallback).toBeNull()
    })

    it('getModelTier returns undefined for unknown tier', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      expect(service.getModelTier('t99_unknown')).toBeUndefined()
    })

    it('getTaskTier resolves task to tier entry', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()

      const tier = service.getTaskTier('intent_classification')
      expect(tier).toBeDefined()
      expect(tier!.provider).toBe('ollama')
      expect(tier!.model).toBe('gemma4:12b-q4_K_M')
    })

    it('getTaskTier returns t2_quality for governance', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()

      const tier = service.getTaskTier('governance')
      expect(tier).toBeDefined()
      expect(tier!.provider).toBe('anthropic')
      expect(tier!.model).toBe('claude-sonnet-4-6')
    })

    it('getTaskTier returns undefined for unknown task', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      expect(service.getTaskTier('unknown_task')).toBeUndefined()
    })

    it('getTaskTierKey returns tier key string', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      expect(service.getTaskTierKey('intent_classification')).toBe('t0_local')
      expect(service.getTaskTierKey('governance')).toBe('t2_quality')
      expect(service.getTaskTierKey('unknown')).toBeUndefined()
    })

    it('hasThreeTierRouting returns true when configured', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      expect(service.hasThreeTierRouting()).toBe(true)
    })

    it('hasThreeTierRouting returns false for legacy-only config', () => {
      writeValidConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      expect(service.hasThreeTierRouting()).toBe(false)
    })

    it('backward compat: get("ai").models still works with three-tier config', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()

      const aiConfig = service.get('ai')
      expect(aiConfig.models.fast?.model).toBe('claude-sonnet-4-20250514')
      expect(aiConfig.models.embedding.model).toBe('text-embedding-3-large')
    })

    it('budget thresholds reflect new values', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()

      const aiConfig = service.get('ai')
      expect(aiConfig.monthly_budget.soft_limit_usd).toBe(20)
      expect(aiConfig.monthly_budget.hard_limit_usd).toBe(35)
    })

    it('getTaskRouting returns all routing entries', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()

      const routing = service.getTaskRouting()
      expect(routing).toBeDefined()
      expect(Object.keys(routing!)).toHaveLength(5)
      expect(routing!['entity_extraction']).toBe('t1_fast')
    })

    it('getModelTier returns undefined when model_tiers not configured', () => {
      writeValidConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      expect(service.getModelTier('t0_local')).toBeUndefined()
    })

    it('getTaskTier returns undefined when task_routing not configured', () => {
      writeValidConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      expect(service.getTaskTier('intent_classification')).toBeUndefined()
    })

    it('getMonthlyBudget returns budget from three-tier config', () => {
      writeThreeTierConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      const budget = service.getMonthlyBudget()
      expect(budget.soft_limit_usd).toBe(20)
      expect(budget.hard_limit_usd).toBe(35)
    })

    it('getMonthlyBudget returns defaults from legacy config', () => {
      writeValidConfigs(tmpDir)
      const service = new ConfigService(tmpDir)
      service.load()
      const budget = service.getMonthlyBudget()
      expect(budget.soft_limit_usd).toBe(30)
      expect(budget.hard_limit_usd).toBe(50)
    })

    it('throws on invalid tier references in task_routing (upgraded from warn to throw)', () => {
      const aiWithBadRef = `
litellm_url: "https://api.openai.com/v1"
models:
  fast:
    model: gpt-5.4
    client: litellm
  synthesis:
    model: gpt-5.4
    client: litellm
  governance:
    model: gpt-5.4
    client: litellm
  intent:
    model: gpt-5.4
    client: litellm
  embedding:
    model: text-embedding-3-large
    client: litellm
model_tiers:
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_input: 0.0008
    cost_per_1k_output: 0.004
    fallback: null
task_routing:
  intent_classification: t0_nonexistent
  entity_extraction: t1_fast
monthly_budget:
  soft_limit_usd: 30
  hard_limit_usd: 50
`
      writeFileSync(join(tmpDir, 'brain-views.yaml'), validBrainViews)
      writeFileSync(join(tmpDir, 'pipeline.yaml'), validPipeline)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), aiWithBadRef)
      writeFileSync(join(tmpDir, 'notifications.yaml'), validNotifications)

      const service = new ConfigService(tmpDir)
      // validateAiRoutingConfig now throws hard on unknown task_routing tier references
      // (upgraded from non-fatal warn to fail-fast throw in P02a)
      expect(() => service.load()).toThrow(/t0_nonexistent/)
    })
  })

  // ================================================================
  // validateAiRoutingConfig — cost field validation tests (P02a)
  // ================================================================

  describe('ai-routing cost validation', () => {
    // Helpers to build minimal valid configs for other 3 files
    function writeAuxConfigs(dir: string): void {
      writeFileSync(join(dir, 'brain-views.yaml'), validBrainViews)
      writeFileSync(join(dir, 'pipeline.yaml'), validPipeline)
      writeFileSync(join(dir, 'notifications.yaml'), validNotifications)
    }

    // Minimal valid ai-routing.yaml with paid-provider tiers that have cost fields
    const validTieredAi = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_input: 0.0008
    cost_per_1k_output: 0.004
    fallback: null
task_routing:
  entity_extraction: t1_fast
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`

    // 3.4.1: paid-provider tier missing cost_per_1k_input → throw
    it('throws when paid-provider tier is missing cost_per_1k_input', () => {
      const ai = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_output: 0.004
    fallback: null
task_routing:
  entity_extraction: t1_fast
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`
      writeAuxConfigs(tmpDir)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), ai)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).toThrow(/cost_per_1k_input/)
      expect(() => service.load()).toThrow(/t1_fast/)
    })

    // 3.4.2: paid-provider tier has cost_per_1k_input but not cost_per_1k_output → throw
    it('throws when paid-provider tier is missing cost_per_1k_output', () => {
      const ai = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_input: 0.0008
    fallback: null
task_routing:
  entity_extraction: t1_fast
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`
      writeAuxConfigs(tmpDir)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), ai)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).toThrow(/cost_per_1k_output/)
      expect(() => service.load()).toThrow(/t1_fast/)
    })

    // 3.4.3: paid-provider tier with explicit 0 cost → does NOT throw (self-declared free)
    it('does not throw when paid-provider tier declares explicit zero costs', () => {
      const ai = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t1_spark:
    provider: openai_compat
    model: "qwen3.5-35b"
    base_url: "http://spark.k4jda.net:8000/v1"
    max_completion_tokens: 4096
    timeout_ms: 120000
    cost_per_1k_input: 0
    cost_per_1k_output: 0
    fallback: null
task_routing:
  entity_extraction: t1_spark
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`
      writeAuxConfigs(tmpDir)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), ai)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).not.toThrow()
    })

    // 3.4.4: ollama provider tier with no cost fields → does NOT throw (exempt)
    it('does not throw when ollama provider tier has no cost fields', () => {
      const ai = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t0_local:
    provider: ollama
    model: "gemma4:12b-q4_K_M"
    base_url: "http://ollama:11434/v1"
    max_completion_tokens: 256
    timeout_ms: 10000
    fallback: null
task_routing:
  intent_classification: t0_local
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`
      writeAuxConfigs(tmpDir)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), ai)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).not.toThrow()
    })

    // 3.4.5: task_routing references non-existent tier → throw containing tier name
    it('throws when task_routing references a non-existent tier', () => {
      const ai = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_input: 0.0008
    cost_per_1k_output: 0.004
    fallback: null
task_routing:
  entity_extraction: t99_nonexistent
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`
      writeAuxConfigs(tmpDir)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), ai)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).toThrow(/t99_nonexistent/)
    })

    // 3.4.6: tier's fallback references non-existent tier → throw containing fallback name
    it('throws when a tier fallback references a non-existent tier', () => {
      const ai = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_input: 0.0008
    cost_per_1k_output: 0.004
    fallback: t0_missing_tier
task_routing:
  entity_extraction: t1_fast
monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
`
      writeAuxConfigs(tmpDir)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), ai)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).toThrow(/t0_missing_tier/)
    })

    // 3.4.7: hard_limit_usd <= soft_limit_usd → throw containing both values
    it('throws when hard_limit_usd is not greater than soft_limit_usd', () => {
      const ai = `
models:
  embedding:
    model: text-embedding-3-large
    client: litellm
    cost_per_1k_input: 0.00013
    cost_per_1k_output: 0
model_tiers:
  t1_fast:
    provider: anthropic
    model: "claude-haiku-4-5-20251001"
    max_completion_tokens: 4096
    timeout_ms: 20000
    cost_per_1k_input: 0.0008
    cost_per_1k_output: 0.004
    fallback: null
task_routing:
  entity_extraction: t1_fast
monthly_budget:
  soft_limit_usd: 30
  hard_limit_usd: 20
`
      writeAuxConfigs(tmpDir)
      writeFileSync(join(tmpDir, 'ai-routing.yaml'), ai)
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).toThrow(/20/)
      expect(() => service.load()).toThrow(/30/)
    })

    // 3.5.1: production drift guard — real config/ai-routing.yaml must pass validation
    it('production ai-routing.yaml passes all validation rules (drift guard)', () => {
      writeAuxConfigs(tmpDir)
      copyFileSync(PROD_AI_ROUTING, join(tmpDir, 'ai-routing.yaml'))
      const service = new ConfigService(tmpDir)
      expect(() => service.load()).not.toThrow()
    })
  })
})
