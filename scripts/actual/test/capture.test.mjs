import { describe, it, expect } from 'vitest'
import { buildCapture, formatMoney } from '../lib/capture.mjs'

// Synthetic payees/amounts only. Amounts are integer minor units (cents).
function sampleInput(overrides = {}) {
  return {
    date: '2026-07-16',
    accounts: [
      { id: 'a', name: 'Checking', balance: 250000 },
      { id: 'b', name: 'Savings', balance: 1000000 },
    ],
    notableTransactions: [{ amount: -60000, payee: 'Big Spend Co' }],
    balanceAlerts: [{ id: 'a', name: 'Checking', prev: 100000, curr: 250000, pctChange: 1.5 }],
    categoryRollup: [
      { category: 'Groceries', count: 4, totalMinor: -32000 },
      { category: 'Fuel', count: 1, totalMinor: -5000 },
    ],
    unmatchedPayees: ['Brand New Vendor', 'Another Unknown'],
    excluded: { transfer: 3, investment: 2 },
    syncFailed: false,
    ...overrides,
  }
}

describe('formatMoney', () => {
  it('formats integer minor units as a dollar string', () => {
    expect(formatMoney(250000)).toBe('$2,500.00')
    expect(formatMoney(-5001)).toBe('-$50.01')
    expect(formatMoney(0)).toBe('$0.00')
  })
})

describe('buildCapture', () => {
  it('produces exactly one capture with the fixed source/type/view contract', () => {
    const cap = buildCapture(sampleInput())
    expect(cap.source).toBe('api')
    expect(cap.capture_type).toBe('observation')
    expect(cap.brain_view).toBe('personal')
    expect(typeof cap.content).toBe('string')
    expect(cap.content.length).toBeGreaterThan(0)
  })

  it('date-stamps the content so a same-day re-run is a duplicate (idempotency)', () => {
    expect(buildCapture(sampleInput()).content).toContain('2026-07-16')
    expect(buildCapture(sampleInput()).metadata.date).toBe('2026-07-16')
  })

  it('includes the unmatched-payee report — count AND each name (§5.1)', () => {
    const cap = buildCapture(sampleInput())
    expect(cap.content).toMatch(/2 unmatched/i)
    expect(cap.content).toContain('Brand New Vendor')
    expect(cap.content).toContain('Another Unknown')
    expect(cap.metadata.unmatched_count).toBe(2)
    expect(cap.metadata.unmatched_payees).toEqual(['Brand New Vendor', 'Another Unknown'])
  })

  it('states plainly when there are no unmatched payees', () => {
    const cap = buildCapture(sampleInput({ unmatchedPayees: [] }))
    expect(cap.content).toMatch(/0 unmatched|all .* categorized|no unmatched/i)
    expect(cap.metadata.unmatched_count).toBe(0)
  })

  it('reports a bank-sync failure when syncFailed, and omits it otherwise', () => {
    expect(buildCapture(sampleInput({ syncFailed: true })).content).toMatch(/bank sync failed/i)
    expect(buildCapture(sampleInput({ syncFailed: true })).metadata.sync_failed).toBe(true)
    expect(buildCapture(sampleInput({ syncFailed: false })).content).not.toMatch(/bank sync failed/i)
  })

  it('carries a total balance and notable/excluded counts in metadata', () => {
    const cap = buildCapture(sampleInput())
    expect(cap.metadata.total_balance_minor).toBe(1250000) // 250000 + 1000000
    expect(cap.metadata.notable_count).toBe(1)
    expect(cap.metadata.excluded).toEqual({ transfer: 3, investment: 2 })
    // the human-readable total appears in the content too
    expect(cap.content).toContain('$12,500.00')
  })
})
