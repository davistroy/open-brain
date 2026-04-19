/**
 * P11b — metrics route tests.
 *
 * Verifies that the two new gauges added in P11b are present in the /metrics
 * Prometheus exposition output:
 *   - openbrain_budget_spent_usd (refreshed from ai_audit_log DB query)
 *   - openbrain_composio_monthly_usage (refreshed from Redis key)
 *
 * Tests use mock db and redis so no external services are required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import { budgetSpentUsd, composioMonthlyUsage } from '../routes/metrics.js'

// Reset gauges before each test to avoid cross-test state
beforeEach(() => {
  budgetSpentUsd.set(0)
  composioMonthlyUsage.set(0)
})

describe('GET /metrics — P11b gauges', () => {
  it('returns openbrain_budget_spent_usd gauge when db is not provided (default 0)', async () => {
    const app = createApp({})
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('openbrain_budget_spent_usd')
  })

  it('returns openbrain_composio_monthly_usage gauge when redis is not provided (default 0)', async () => {
    const app = createApp({})
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('openbrain_composio_monthly_usage')
  })

  it('refreshes openbrain_budget_spent_usd from DB on each scrape', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [{ total: '27.50' }] }),
    }
    const app = createApp({ db: mockDb as any })

    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()

    // Gauge must be present with value 27.5
    // prom-client emits default labels, so line is: openbrain_budget_spent_usd{app="..."} 27.5
    expect(text).toMatch(/openbrain_budget_spent_usd(\{[^}]*\})?\s+27\.5/)
    expect(mockDb.execute).toHaveBeenCalledOnce()
  })

  it('refreshes openbrain_composio_monthly_usage from Redis on each scrape', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue('12345'),
    }
    const app = createApp({ metricsRedis: mockRedis })

    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()

    // Gauge must be present with value 12345
    // prom-client emits default labels, so line is: openbrain_composio_monthly_usage{app="..."} 12345
    expect(text).toMatch(/openbrain_composio_monthly_usage(\{[^}]*\})?\s+12345/)
    expect(mockRedis.get).toHaveBeenCalledOnce()
    // Key should be composio:monthly_usage:YYYY-MM
    const key = mockRedis.get.mock.calls[0][0] as string
    expect(key).toMatch(/^composio:monthly_usage:\d{4}-\d{2}$/)
  })

  it('returns 0 for openbrain_budget_spent_usd when DB query returns null', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [{ total: null }] }),
    }
    const app = createApp({ db: mockDb as any })

    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()

    // prom-client emits default labels, so line is: openbrain_budget_spent_usd{app="..."} 0
    expect(text).toMatch(/openbrain_budget_spent_usd(\{[^}]*\})?\s+0/)
  })

  it('does not throw if DB query fails — serves stale gauge value (0)', async () => {
    const mockDb = {
      execute: vi.fn().mockRejectedValue(new Error('DB connection refused')),
    }
    const app = createApp({ db: mockDb as any })

    // Should not throw even when DB fails
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('openbrain_budget_spent_usd')
  })

  it('does not throw if Redis query fails — serves stale gauge value (0)', async () => {
    const mockRedis = {
      get: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
    }
    const app = createApp({ metricsRedis: mockRedis })

    // Should not throw even when Redis fails
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('openbrain_composio_monthly_usage')
  })

  it('returns standard metrics alongside new gauges', async () => {
    const app = createApp({})
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()

    // Pre-existing metrics must still be present
    expect(text).toContain('openbrain_http_requests_total')
    expect(text).toContain('openbrain_captures_total')
    expect(text).toContain('openbrain_llm_cost_usd_total')
    // New P11b gauges
    expect(text).toContain('openbrain_budget_spent_usd')
    expect(text).toContain('openbrain_composio_monthly_usage')
  })
})
