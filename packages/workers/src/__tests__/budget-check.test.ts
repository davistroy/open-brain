import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processBudgetCheckJob } from '../jobs/budget-check.js'
import type { BudgetCheckJobData } from '../jobs/budget-check.js'
import { PushoverService } from '../services/pushover.js'

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
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.LITELLM_API_KEY
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        // no litellmApiKey provided
        softLimit: 30,
        hardLimit: 50,
      })

      // fetch should not have been called for LiteLLM spend endpoint
      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.spendSource).toBe('local')
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
        // no softLimit override — should read from env
      })

      // $25 > $20 soft limit → alert
      expect(result.thresholdCrossed).toBe('soft')
      expect(sendSpy).toHaveBeenCalledOnce()
      expect(sendSpy.mock.calls[0][0].priority).toBe(0)
    })

    it('defaults to $30 soft limit when env var not set', async () => {
      vi.stubGlobal('fetch', makeLiteLLMFetch({ total_cost: 25.00 }))

      const db = makeDb(null)
      const pushover = new PushoverService('tok', 'usr')
      const sendSpy = vi.spyOn(pushover, 'send').mockResolvedValue(undefined)

      await processBudgetCheckJob(JOB_DATA, db as never, pushover, {
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
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
        litellmApiKey: 'test-key',
        softLimit: 30,
        hardLimit: 50,
      })

      const { message } = sendSpy.mock.calls[0][0]
      expect(message).toContain('combined') // both sources available
    })
  })
})
