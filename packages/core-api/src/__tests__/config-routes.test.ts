/**
 * Config route tests — Phase 4.1 of IMPLEMENTATION_PLAN-ARCH-REVIEW.md.
 *
 * Routes under test:
 *   GET /api/v1/config/ai-routing     — model routing table + per-model monthly spend
 *   GET /api/v1/config/integrations   — integration connectivity statuses
 *
 * Strategy:
 *   - Use makeTestApp + registerConfigRoutes directly (no createApp) — faster,
 *     no rate-limiter, no pg/redis/ioredis stubs required.
 *   - configService is a minimal vi.fn() object that implements only .get().
 *   - BudgetService is injected as a mock (Phase 5.2 extraction) — the route's
 *     4th param. db.execute() is kept for the integrations endpoint (MCP last_call).
 *   - Environment variable checks (SLACK_BOT_TOKEN, WIKI_REPO_URL) are isolated
 *     per-test via vi.stubEnv / process.env assignment + cleanup.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ConfigService } from '@open-brain/shared'
import type { BudgetService, SpendResult } from '../services/budget.service.js'
import { registerConfigRoutes } from '../routes/config.js'
import { makeTestApp, testJson, makeMockService } from './helpers.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal AIConfig shape that satisfies the route's configService.get('ai') call */
function makeAiConfig(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      fast: { model: 'gpt-5.4', client: 'litellm', cost_per_1k_input: 0.003, cost_per_1k_output: 0.015 },
      synthesis: { model: 'claude-opus-4', client: 'anthropic', cost_per_1k_input: 0.015, cost_per_1k_output: 0.075 },
    },
    monthly_budget: {
      soft_limit_usd: 30,
      hard_limit_usd: 50,
    },
    ...overrides,
  }
}

/** Default empty SpendResult (no spend in DB) */
function makeSpendResult(overrides: Partial<SpendResult> = {}): SpendResult {
  return {
    byModel: {},
    monthTotal: 0,
    ...overrides,
  }
}

/** Build a mock ConfigService with a .get() spy */
function makeMockConfigService(aiConfig = makeAiConfig()): Pick<ConfigService, 'get'> {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'ai') return aiConfig
      throw new Error(`ConfigService.get('${key}') not mocked`)
    }),
  }
}

/** Build a mock BudgetService using makeMockService. */
function makeMockBudgetService(spendResult = makeSpendResult()) {
  const svc = makeMockService<BudgetService>(['getSpend'])
  svc.getSpend.mockResolvedValue(spendResult)
  return svc
}

/** Build a mock db with .execute() used only by the integrations route (MCP last_call). */
function makeMockDb(lastCallRow: { last_call: string | null } | null = null) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: lastCallRow ? [lastCallRow] : [] }),
  }
}

function buildApp(
  configService = makeMockConfigService(),
  budgetService = makeMockBudgetService(),
  db = makeMockDb(),
) {
  const app = makeTestApp((a) => {
    registerConfigRoutes(
      a,
      configService as unknown as ConfigService,
      db as any,
      budgetService as unknown as BudgetService,
    )
  })
  return { app, configService, budgetService, db }
}

// ---------------------------------------------------------------------------
// GET /api/v1/config/ai-routing — happy path
// ---------------------------------------------------------------------------

describe('GET /api/v1/config/ai-routing — happy path', () => {
  it('returns 200 with models array and budget envelope', async () => {
    const { app } = buildApp()
    const { status, body } = await testJson(app, '/api/v1/config/ai-routing')

    expect(status).toBe(200)
    const b = body as { models: unknown[]; budget: Record<string, number> }
    expect(Array.isArray(b.models)).toBe(true)
    expect(b.models.length).toBeGreaterThan(0)
    expect(b.budget).toMatchObject({
      soft_limit_usd: 30,
      hard_limit_usd: 50,
    })
    expect(typeof b.budget.month_total_usd).toBe('number')
  })

  it('maps each config model to a ModelRoutingEntry with required fields', async () => {
    const { app } = buildApp()
    const { body } = await testJson(app, '/api/v1/config/ai-routing')

    const b = body as { models: Array<Record<string, unknown>> }
    for (const entry of b.models) {
      expect(typeof entry.task).toBe('string')
      expect(typeof entry.model).toBe('string')
      expect(typeof entry.client).toBe('string')
      expect(typeof entry.cost_per_1k_input).toBe('number')
      expect(typeof entry.cost_per_1k_output).toBe('number')
      expect(typeof entry.month_spend_usd).toBe('number')
      expect(typeof entry.month_calls).toBe('number')
    }
  })

  it('merges BudgetService spend into the correct model entry', async () => {
    const budgetService = makeMockBudgetService(
      makeSpendResult({ byModel: { 'gpt-5.4': { spend: 1.234567, calls: 42 } }, monthTotal: 1.234567 }),
    )
    const { app } = buildApp(makeMockConfigService(), budgetService)
    const { body } = await testJson(app, '/api/v1/config/ai-routing')

    const b = body as { models: Array<{ model: string; month_spend_usd: number; month_calls: number }> }
    const fastEntry = b.models.find((m) => m.model === 'gpt-5.4')
    expect(fastEntry).toBeDefined()
    expect(fastEntry!.month_calls).toBe(42)
    expect(fastEntry!.month_spend_usd).toBeCloseTo(1.234567, 5)
  })

  it('returns zero spend for models with no ai_audit_log rows', async () => {
    const budgetService = makeMockBudgetService(makeSpendResult()) // empty spend
    const { app } = buildApp(makeMockConfigService(), budgetService)
    const { body } = await testJson(app, '/api/v1/config/ai-routing')

    const b = body as { models: Array<{ month_spend_usd: number; month_calls: number }> }
    for (const entry of b.models) {
      expect(entry.month_spend_usd).toBe(0)
      expect(entry.month_calls).toBe(0)
    }
  })

  it('returns zero spend when BudgetService.getSpend() returns empty (graceful degradation)', async () => {
    // BudgetService itself swallows DB errors and returns empty — route still returns 200
    const budgetService = makeMockBudgetService(makeSpendResult())
    const { app } = buildApp(makeMockConfigService(), budgetService)
    const { status, body } = await testJson(app, '/api/v1/config/ai-routing')

    expect(status).toBe(200)
    const b = body as { models: Array<{ month_spend_usd: number }> }
    for (const entry of b.models) {
      expect(entry.month_spend_usd).toBe(0)
    }
  })

  it('returns 500 AppError when configService.get() throws', async () => {
    const brokenConfig = {
      get: vi.fn().mockImplementation(() => {
        throw new Error('Config not loaded')
      }),
    }
    const { app } = buildApp(brokenConfig as unknown as ConfigService)
    const { status, body } = await testJson(app, '/api/v1/config/ai-routing')

    expect(status).toBe(500)
    const b = body as { code: string }
    expect(b.code).toBe('CONFIG_LOAD_FAILED')
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/config/integrations — environment-driven checks
// ---------------------------------------------------------------------------

describe('GET /api/v1/config/integrations', () => {
  const originalSlack = process.env.SLACK_BOT_TOKEN
  const originalWiki = process.env.WIKI_REPO_URL

  afterEach(() => {
    // Restore env after each test
    if (originalSlack === undefined) {
      delete process.env.SLACK_BOT_TOKEN
    } else {
      process.env.SLACK_BOT_TOKEN = originalSlack
    }
    if (originalWiki === undefined) {
      delete process.env.WIKI_REPO_URL
    } else {
      process.env.WIKI_REPO_URL = originalWiki
    }
  })

  it('returns 200 with an integrations array', async () => {
    const { app } = buildApp()
    const { status, body } = await testJson(app, '/api/v1/config/integrations')

    expect(status).toBe(200)
    const b = body as { integrations: unknown[] }
    expect(Array.isArray(b.integrations)).toBe(true)
    expect(b.integrations.length).toBeGreaterThan(0)
  })

  it('each integration entry has name and status fields', async () => {
    const { app } = buildApp()
    const { body } = await testJson(app, '/api/v1/config/integrations')

    const b = body as { integrations: Array<{ name: string; status: string }> }
    for (const entry of b.integrations) {
      expect(typeof entry.name).toBe('string')
      expect(['connected', 'disconnected', 'unknown']).toContain(entry.status)
    }
  })

  it('reports Slack as connected when SLACK_BOT_TOKEN is set', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    const { app } = buildApp()
    const { body } = await testJson(app, '/api/v1/config/integrations')

    const b = body as { integrations: Array<{ name: string; status: string }> }
    const slack = b.integrations.find((i) => i.name === 'Slack')
    expect(slack).toBeDefined()
    expect(slack!.status).toBe('connected')
  })

  it('reports Slack as disconnected when SLACK_BOT_TOKEN is absent', async () => {
    delete process.env.SLACK_BOT_TOKEN
    const { app } = buildApp()
    const { body } = await testJson(app, '/api/v1/config/integrations')

    const b = body as { integrations: Array<{ name: string; status: string }> }
    const slack = b.integrations.find((i) => i.name === 'Slack')
    expect(slack).toBeDefined()
    expect(slack!.status).toBe('disconnected')
  })

  it('reports Gitea as connected when WIKI_REPO_URL is set', async () => {
    process.env.WIKI_REPO_URL = 'http://gitea.tale-mamba.ts.net:3000/davistroy/open-brain-wiki'
    const { app } = buildApp()
    const { body } = await testJson(app, '/api/v1/config/integrations')

    const b = body as { integrations: Array<{ name: string; status: string; url?: string }> }
    const gitea = b.integrations.find((i) => i.name === 'Gitea')
    expect(gitea).toBeDefined()
    expect(gitea!.status).toBe('connected')
    expect(gitea!.url).toBe('http://gitea.tale-mamba.ts.net:3000/davistroy/open-brain-wiki')
  })

  it('reports Gitea as disconnected when WIKI_REPO_URL is absent', async () => {
    delete process.env.WIKI_REPO_URL
    const { app } = buildApp()
    const { body } = await testJson(app, '/api/v1/config/integrations')

    const b = body as { integrations: Array<{ name: string; status: string }> }
    const gitea = b.integrations.find((i) => i.name === 'Gitea')
    expect(gitea).toBeDefined()
    expect(gitea!.status).toBe('disconnected')
  })

  it('always reports MCP as connected (embedded in core-api)', async () => {
    const db = makeMockDb({ last_call: '2026-05-05T08:00:00Z' })
    const { app } = buildApp(makeMockConfigService(), makeMockBudgetService(), db as any)
    const { body } = await testJson(app, '/api/v1/config/integrations')

    const b = body as { integrations: Array<{ name: string; status: string }> }
    const mcp = b.integrations.find((i) => i.name === 'MCP')
    expect(mcp).toBeDefined()
    expect(mcp!.status).toBe('connected')
  })
})
