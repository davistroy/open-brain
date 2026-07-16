import { describe, it, expect } from 'vitest'
import { notableTransactions, balanceAlerts, toBalanceMap, isFirstRun } from '../lib/alerts.mjs'

// Amounts are integer minor units (cents), the Actual API convention.
// $500 = 50000. Synthetic data only.
const T500 = 50000

describe('notableTransactions', () => {
  const txs = [
    { id: 't1', amount: -60000, payee_name: 'Big Spend' }, // -$600
    { id: 't2', amount: 50000, payee_name: 'Exactly 500' }, // $500 boundary
    { id: 't3', amount: 50001, payee_name: 'Just Over' }, // $500.01
    { id: 't4', amount: -1200, payee_name: 'Small' }, // -$12
  ]

  it('returns transactions whose absolute amount exceeds the threshold', () => {
    const notable = notableTransactions(txs, { thresholdMinor: T500 })
    expect(notable.map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('excludes a transaction exactly at the threshold (strictly greater than)', () => {
    const notable = notableTransactions([{ id: 'x', amount: T500 }], { thresholdMinor: T500 })
    expect(notable).toHaveLength(0)
  })

  it('flags large spends (negative) and large income (positive) alike', () => {
    const notable = notableTransactions(
      [{ id: 'in', amount: 90000 }, { id: 'out', amount: -90000 }],
      { thresholdMinor: T500 },
    )
    expect(notable.map((t) => t.id).sort()).toEqual(['in', 'out'])
  })
})

describe('balanceAlerts', () => {
  const accounts = [
    { id: 'a', name: 'Checking', balance: 106000 }, // was 100000 → +6%
    { id: 'b', name: 'Savings', balance: 105000 }, // was 100000 → +5% (boundary)
    { id: 'c', name: 'Card', balance: 100000 }, // unchanged
  ]
  const prev = { a: 100000, b: 100000, c: 100000 }

  it('flags an account whose balance moved more than the threshold percentage', () => {
    const alerts = balanceAlerts(prev, accounts, { pct: 0.05 })
    expect(alerts.map((x) => x.id)).toEqual(['a'])
    expect(alerts[0]).toMatchObject({ id: 'a', name: 'Checking', prev: 100000, curr: 106000 })
  })

  it('does NOT flag a move exactly at the threshold (strictly greater than)', () => {
    const alerts = balanceAlerts(prev, accounts, { pct: 0.05 })
    expect(alerts.map((x) => x.id)).not.toContain('b')
  })

  it('returns no alerts on the first run (no baseline)', () => {
    expect(balanceAlerts(null, accounts, { pct: 0.05 })).toEqual([])
    expect(balanceAlerts({}, accounts, { pct: 0.05 })).toEqual([])
  })

  it('skips an account that has no prior baseline (new account) without crashing', () => {
    const withNew = [...accounts, { id: 'd', name: 'Brand New', balance: 999999 }]
    const alerts = balanceAlerts(prev, withNew, { pct: 0.05 })
    expect(alerts.map((x) => x.id)).not.toContain('d')
  })

  it('flags an account that went from zero to non-zero (infinite change)', () => {
    const alerts = balanceAlerts({ a: 0 }, [{ id: 'a', name: 'Checking', balance: 5000 }], { pct: 0.05 })
    expect(alerts.map((x) => x.id)).toEqual(['a'])
  })
})

describe('toBalanceMap / isFirstRun', () => {
  it('toBalanceMap reduces accounts to an id→balance map', () => {
    expect(toBalanceMap([{ id: 'a', name: 'x', balance: 10 }, { id: 'b', name: 'y', balance: 20 }])).toEqual({ a: 10, b: 20 })
  })

  it('isFirstRun is true for null or an empty map, false otherwise', () => {
    expect(isFirstRun(null)).toBe(true)
    expect(isFirstRun({})).toBe(true)
    expect(isFirstRun({ a: 1 })).toBe(false)
  })
})
