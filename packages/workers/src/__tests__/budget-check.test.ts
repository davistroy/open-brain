import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resetAlertStateMirror } from '../lib/alert-state.js'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { processBudgetCheckJob } from '../jobs/budget-check.js'
import type { BudgetCheckJobData } from '../jobs/budget-check.js'
import { PushoverService } from '../services/pushover.js'
import { alertStateKey, type AlertState } from '../lib/alert-state.js'

beforeEach(() => resetAlertStateMirror())

// ============================================================
// Mock fetch globally
// ============================================================

function makeLiteLLMFetch(response: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(response),
    text: vi.fn().mockResolvedValue(JSON.stringify(response)),
  })
}

function makeFetchError() {
  return vi.fn().mockRejectedValue(new Error('Network error'))
}

// ============================================================
// Mock database
// ============================================================

function makeDb(totalTokens: number | null, callCount = 10) {
  return {
    execute: vi.fn().mockResolvedValue({
      rows: [{ total_tokens: totalTokens !== null ? String(totalTokens) : null, call_count: String(callCount) }],
    }),
  }
}

function makeDbError() {
  return {
    execute: vi.fn().mockRejectedValue(new Error('DB connection error')),
  }
}

// ============================================================
// Fixtures
// ============================================================

const JOB_DATA: BudgetCheckJobData = { triggeredAt: '2026-03-06T08:00:00Z' }

const LITELLM_ARRAY_RESPONSE = [
  { spend: 10.50, model: 'gpt-4o' },
  { spend: 5.25, model: 'claude-opus-4' },
  { spend: 2.75, model: 'text-embedding-3-small' },
]

const LITELLM_TOTAL_COST_RESPONSE = { total_cost: 18.50 }

// ============================================================
// Tests
// ============================================================

describe('processBudgetCheckJob', () => {
  // This suite pins the legacy direct-push behavior (as at f341ca6) with the
  // alert-state path off. The ADR-0005 path and the switch matrix are covered
  // in the "alert state" suite at the end of the file.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubEnv('ALERT_STATE_ENABLED', 'false')
    delete process.env.OPENAI_API_KEY
    delete process.env.LLM_SPEND_API_KEY
    delete process.env.LLM_SPEND_URL
    delete process.env.BUDGET_SOFT_LIMIT
    delete process.env.BUDGET_HARD_LIMIT
    delete process.env.PUSHOVER_APP_TOKEN
    delete process.env.PUSHOVER_USER_KEY
  })

  // ----------------------------------------------------------
  // Under threshold — no alert
  // ----------------------------------------------------------

  describe('spend under soft limit', () => {
    it('returns no alert and logs spend when under soft limit', async () => {
      // LiteLLM returns $5 spend — well under $30 soft limit
      vi.stubGlobal('fetch', makeLiteLLMFetch(LITELLM_TOTAL_COST_RESPONSE))
      // Override total_cost to 5.00
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 5.00 }))

      const db = makeDb(4_000_000) // 4M tokens ≈ $4 local estimate
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.alertSent).toBe(false)
      expect(result.thresholdCrossed).toBeNull()
      expect(result.monthlySpend).toBe(5.00)
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('reports spend source as combined when both LiteLLM and local data available', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 8.00 }))

      const db = makeDb(6_000_000)
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.spendSource).toBe('combined')
    })
  })

  // ----------------------------------------------------------
  // Soft limit crossed
  // ----------------------------------------------------------

  describe('spend at or above soft limit', () => {
    it('sends normal priority (0) Pushover alert when spend >= soft limit', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 31.50 }))

      const db = makeDb(20_000_000)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.alertSent).toBe(true)
      expect(result.thresholdCrossed).toBe('soft')
      expect(result.monthlySpend).toBe(31.50)

      expect(sendSpy).toHaveBeenCalledOnce()
      const callArgs = sendSpy.mock.calls[0][0]
      expect(callArgs.priority).toBe(0)
      expect(callArgs.title).toContain('Soft Limit')
      expect(callArgs.message).toContain('$31.50')
      expect(callArgs.message).toContain('$30')
    })

    it('formats spend amount to 2 decimal places in alert message', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 30.1234 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      const message = sendSpy.mock.calls[0][0].message
      expect(message).toContain('$30.12')
    })

    it('sends alert at exactly the soft limit boundary', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 30.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.thresholdCrossed).toBe('soft')
      expect(sendSpy).toHaveBeenCalledOnce()
    })
  })

  // ----------------------------------------------------------
  // Hard limit crossed
  // ----------------------------------------------------------

  describe('spend at or above hard limit', () => {
    it('sends high priority (1) Pushover alert when spend >= hard limit', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 51.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.alertSent).toBe(true)
      expect(result.thresholdCrossed).toBe('hard')

      const callArgs = sendSpy.mock.calls[0][0]
      expect(callArgs.priority).toBe(1)
      expect(callArgs.title).toContain('Hard Limit')
      expect(callArgs.message).toContain('$51.00')
    })

    it('only sends hard alert (not soft + hard) when spend is above hard limit', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 55.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      // Only one alert — hard limit
      expect(sendSpy).toHaveBeenCalledOnce()
      expect(sendSpy.mock.calls[0][0].priority).toBe(1)
    })
  })

  // ----------------------------------------------------------
  // LiteLLM spend API response formats
  // ----------------------------------------------------------

  describe('LiteLLM spend API response formats', () => {
    it('sums spend from array response format', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch(LITELLM_ARRAY_RESPONSE))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      // 10.50 + 5.25 + 2.75 = 18.50
      expect(result.monthlySpend).toBeCloseTo(18.50, 2)
      // null tokens → localSpend=0 (not null), so both sources present → 'combined'
      expect(result.spendSource).toBe('combined')
    })

    it('uses total_cost field from object response format', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 22.75 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.monthlySpend).toBe(22.75)
      // null tokens → localSpend=0 (not null), so both sources present → 'combined'
      expect(result.spendSource).toBe('combined')
    })

    it('uses spend field from object response format', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ spend: 15.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.monthlySpend).toBe(15.00)
    })

    it('also handles array items with total_cost instead of spend', async () => {
      const arrayWithTotalCost = [
        { total_cost: 5.00, model: 'gpt-4o' },
        { total_cost: 8.00, model: 'claude-opus-4' },
      ]
      vi.stubGlobal('fetch', makeLiteLLMFetch(arrayWithTotalCost))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.monthlySpend).toBeCloseTo(13.00, 2)
    })
  })

  // ----------------------------------------------------------
  // LiteLLM API failure fallback
  // ----------------------------------------------------------

  describe('LiteLLM API failure — fallback to local data', () => {
    it('falls back to local ai_audit_log when LiteLLM returns non-2xx', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({}, false, 500))

      // 30M tokens * $1/M = $30 → triggers soft alert
      const db = makeDb(30_000_000)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.spendSource).toBe('local')
      expect(result.monthlySpend).toBeCloseTo(30.00, 2)
      expect(result.thresholdCrossed).toBe('soft')
      expect(sendSpy).toHaveBeenCalledOnce()
    })

    it('falls back to local data when LiteLLM fetch throws network error', async () => {
      vi.stubGlobal('fetch', makeFetchError())

      const db = makeDb(10_000_000) // 10M tokens ≈ $10
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.spendSource).toBe('local')
      expect(result.alertSent).toBe(false)
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('skips LiteLLM query entirely when no API key is set', async () => {
      const mockFetch = makeLiteLLMFetch({ total_cost: 99.00 })
      vi.stubGlobal('fetch', mockFetch)

      const db = makeDb(5_000_000) // $5 local estimate
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        // no spendApiKey provided
        softLimit: 30,
        hardLimit: 50,
      })

      // fetch should not have been called for LiteLLM spend endpoint
      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.spendSource).toBe('local')
    })

    it('skips LiteLLM query entirely when no spend URL is set (default)', async () => {
      const mockFetch = makeLiteLLMFetch({ total_cost: 99.00 })
      vi.stubGlobal('fetch', mockFetch)

      const db = makeDb(5_000_000) // $5 local estimate
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        // no llmSpendUrl — defaults to empty string
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      // fetch should not have been called — no spend URL configured
      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.spendSource).toBe('local')
      expect(result.monthlySpend).toBeCloseTo(5.00, 2)
    })
  })

  // ----------------------------------------------------------
  // Local ai_audit_log query
  // ----------------------------------------------------------

  describe('local ai_audit_log spend estimation', () => {
    it('estimates cost at $1 per 1M tokens', async () => {
      // Disable LiteLLM (no api key), use local only
      const db = makeDb(12_000_000) // 12M tokens = $12
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.monthlySpend).toBeCloseTo(12.00, 2)
      expect(result.spendSource).toBe('local')
    })

    it('handles null total_tokens gracefully (treats as 0)', async () => {
      const db = makeDb(null, 5) // null tokens
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.monthlySpend).toBe(0)
      expect(result.alertSent).toBe(false)
    })

    it('continues without local data when db query fails', async () => {
      const db = makeDbError()
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        softLimit: 30,
        hardLimit: 50,
      })

      // No LiteLLM key, no local data → spendSource 'none'
      expect(result.spendSource).toBe('none')
      expect(result.alertSent).toBe(false)
    })
  })

  // ----------------------------------------------------------
  // Pushover not configured
  // ----------------------------------------------------------

  describe('Pushover not configured', () => {
    it('returns alertSent=false when Pushover credentials are missing', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 35.00 }))

      const db = makeDb(null)
      // No credentials — Pushover not configured
      const pushover = new PushoverService()

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      // Threshold is crossed but alert couldn't be sent
      expect(result.thresholdCrossed).toBe('soft')
      expect(result.alertSent).toBe(false)
    })

    it('still returns correct spend data when Pushover alert fails', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 45.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      vi.spyOn(pushover, 'send').mockRejectedValue(new Error('Pushover 503'))

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      expect(result.monthlySpend).toBe(45.00)
      expect(result.thresholdCrossed).toBe('soft')
      expect(result.alertSent).toBe(false)
    })
  })

  // ----------------------------------------------------------
  // Environment variable configuration
  // ----------------------------------------------------------

  describe('environment variable configuration', () => {
    it('reads BUDGET_SOFT_LIMIT from environment', async () => {
      process.env.BUDGET_SOFT_LIMIT = '20'

      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 25.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        // no softLimit override — should read from env
      })

      // $25 > $20 soft limit → alert
      expect(result.thresholdCrossed).toBe('soft')
      expect(sendSpy).toHaveBeenCalledOnce()
      expect(sendSpy.mock.calls[0][0].priority).toBe(0)
    })

    it('reads LLM_SPEND_URL from environment', async () => {
      process.env.LLM_SPEND_URL = 'https://llm.env.local'

      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 35.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        spendApiKey: 'test-key',
        // no llmSpendUrl override — should read LLM_SPEND_URL from env
      })

      // $35 > $30 soft limit → alert
      expect(result.thresholdCrossed).toBe('soft')
      expect(sendSpy).toHaveBeenCalledOnce()
    })

    it('defaults to $30 soft limit when env var not set', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 25.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        // no softLimit override, no env var → defaults to 30
      })

      // $25 < $30 → no alert
      expect(sendSpy).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------
  // Alert message content
  // ----------------------------------------------------------

  describe('alert message content', () => {
    it('soft limit message includes spend, threshold, and hard limit reminder', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 33.50 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      const { title, message } = sendSpy.mock.calls[0][0]
      expect(title).toContain('Soft Limit')
      expect(message).toContain('$33.50')
      expect(message).toContain('$30')
      expect(message).toContain('$50') // hard limit reminder
    })

    it('hard limit message includes spend and circuit breaker warning', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 52.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      const { title, message } = sendSpy.mock.calls[0][0]
      expect(title).toContain('Hard Limit')
      expect(message).toContain('$52.00')
      expect(message.toLowerCase()).toContain('circuit breaker')
    })

    it('includes spend source in alert message', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 35.00 }))

      const db = makeDb(25_000_000) // local data available too
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        llmSpendUrl: 'https://llm.test.local',
        spendApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      const { message } = sendSpy.mock.calls[0][0]
      expect(message).toContain('combined') // both sources available
    })
  })
})

// ============================================================
// ADR-0005 alert state (item 2.2): budget-soft / budget-hard
// ============================================================

/** db mock: in-memory alert-state store + the ai_audit_log spend query (no local tokens). */
function makeStatefulDb(opts: { initial?: Record<string, AlertState>; failStateReads?: boolean } = {}) {
  const store = new Map<string, unknown>(
    Object.entries(opts.initial ?? {}).map(([k, v]) => [alertStateKey(k), v]),
  )
  const dialect = new PgDialect()
  const queries: string[] = []
  const execute = vi.fn().mockImplementation(async (q: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    queries.push(text)
    if (text.includes('INSERT INTO app_settings')) {
      store.set(params[0] as string, JSON.parse(params[1] as string))
      return { rows: [] }
    }
    if (text.includes('FROM app_settings')) {
      if (opts.failStateReads) throw new Error('db down')
      const v = store.get(params[0] as string)
      return { rows: v === undefined ? [] : [{ value: v }] }
    }
    if (text.includes('FROM ai_audit_log')) return { rows: [{ total_tokens: null, call_count: '0' }] }
    throw new Error(`unexpected SQL in test: ${text}`)
  })
  return { db: { execute }, store, queries }
}

const OPEN: AlertState = {
  status: 'bad',
  since: '2026-11-20T07:00:00.000Z',
  last_notified_at: '2026-11-20T07:00:00.000Z',
  level: 0,
  receipt: null,
  acked_at: null,
}

describe('processBudgetCheckJob — alert state (ADR-0005)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.LLM_SPEND_URL
    delete process.env.LLM_SPEND_API_KEY
    delete process.env.BUDGET_SOFT_LIMIT
    delete process.env.BUDGET_HARD_LIMIT
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function runWithSpend(spend: number, db: unknown, pushover: PushoverService) {
    vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: spend }))
    return processBudgetCheckJob(JOB_DATA, db as never, pushover, {
      llmSpendUrl: 'https://llm.test.local',
      spendApiKey: 'test-key',
      softLimit: 30,
      hardLimit: 50,
    })
  }

  function makePushover() {
    const pushover = new PushoverService('tok', 'usr')
    const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)
    return { pushover, sendSpy }
  }

  it('both switches on (default): soft limit sends the legacy push AND the budget-soft alert', async () => {
    const { db, store } = makeStatefulDb()
    const { pushover, sendSpy } = makePushover()

    const result = await runWithSpend(31.5, db, pushover)

    expect(sendSpy.mock.calls.map(c => c[0].title)).toEqual([
      'AI Budget Alert — Soft Limit Reached',
      'AI Budget Soft Limit Reached',
    ])
    expect(result.alertSent).toBe(true)
    expect(store.get('alert_state:budget-soft')).toMatchObject({ status: 'bad' })
  })

  it('ALERT_LEGACY_PUSH=false: soft limit sends once (priority 0), none on the next day, "resolved" when spend drops', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, store } = makeStatefulDb()
    const { pushover, sendSpy } = makePushover()

    const first = await runWithSpend(31.5, db, pushover)
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ title: 'AI Budget Soft Limit Reached', priority: 0 })
    expect(sendSpy.mock.calls[0][0].message).toContain('$31.50')
    expect(first.alertSent).toBe(true)
    expect(first.thresholdCrossed).toBe('soft')

    const second = await runWithSpend(33, db, pushover)
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(second.alertSent).toBe(false)
    expect(second.thresholdCrossed).toBe('soft')

    await runWithSpend(2, db, pushover) // new month
    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(sendSpy.mock.calls[1][0]).toMatchObject({ title: 'Resolved: AI Budget Soft Limit Reached', priority: -1 })
    expect(store.get('alert_state:budget-soft')).toMatchObject({ status: 'ok' })
  })

  it('ALERT_LEGACY_PUSH=false: hard limit with the soft alert already open sends one critical (priority 1)', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db, store } = makeStatefulDb({ initial: { 'budget-soft': OPEN } })
    const { pushover, sendSpy } = makePushover()

    const result = await runWithSpend(51, db, pushover)

    expect(sendSpy).toHaveBeenCalledOnce()
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ title: 'AI Budget Hard Limit Reached', priority: 1 })
    expect(result.thresholdCrossed).toBe('hard')
    expect(store.get('alert_state:budget-hard')).toMatchObject({ status: 'bad' })
    expect(store.get('alert_state:budget-soft')).toEqual(OPEN)
  })

  it('ALERT_STATE_ENABLED=false: legacy push only, no alert-state read or write', async () => {
    vi.stubEnv('ALERT_STATE_ENABLED', 'false')
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false') // ignored while the state path is off
    const { db, store, queries } = makeStatefulDb()
    const { pushover, sendSpy } = makePushover()

    await runWithSpend(55, db, pushover)

    expect(sendSpy).toHaveBeenCalledOnce()
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ title: 'AI Budget Warning — Hard Limit Approaching', priority: 1 })
    expect(queries.some(q => q.includes('app_settings'))).toBe(false)
    expect(store.size).toBe(0)
  })

  it('fail open: an alert-state read error still sends the budget alert', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const { db } = makeStatefulDb({ failStateReads: true })
    const { pushover, sendSpy } = makePushover()

    const result = await runWithSpend(51, db, pushover)

    expect(sendSpy.mock.calls.map(c => c[0].title).sort()).toEqual([
      'AI Budget Hard Limit Reached',
      'AI Budget Soft Limit Reached',
    ])
    expect(result.alertSent).toBe(true)
  })

  it('no spend data: no alert-state call, so an open alert is held', async () => {
    vi.stubEnv('ALERT_LEGACY_PUSH', 'false')
    const store = new Map<string, unknown>([[alertStateKey('budget-soft'), OPEN]])
    const db = { execute: vi.fn().mockRejectedValue(new Error('DB connection error')) }
    const { pushover, sendSpy } = makePushover()

    const result = await processBudgetCheckJob(JOB_DATA, db as never, pushover, { softLimit: 30, hardLimit: 50 })

    expect(result.spendSource).toBe('none')
    expect(sendSpy).not.toHaveBeenCalled()
    expect(db.execute).toHaveBeenCalledTimes(1) // the ai_audit_log query only
    expect(store.get(alertStateKey('budget-soft'))).toEqual(OPEN)
  })
})
