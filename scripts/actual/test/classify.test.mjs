import { describe, it, expect } from 'vitest'
import { loadRules } from '../lib/rules.mjs'
import { classify } from '../lib/classify.mjs'

// Synthetic payees only (repo is PUBLIC; data rule).
const RULES = loadRules(`
exclude_transfer:   [ "acme card payment", "wayne p2p" ]
exclude_investment: [ "globex brokerage", "initech 401k" ]
rules:
  - category: Groceries
    match: [ "umbrella foods", "initech market" ]
  - category: Fuel
    match: [ "hooli gas" ]
`)

describe('classify', () => {
  it('returns the first matching rule category (first-match-wins order)', () => {
    expect(classify('UMBRELLA FOODS #42', RULES)).toEqual({ category: 'Groceries', reason: 'rule' })
    expect(classify('Hooli Gas Station', RULES)).toEqual({ category: 'Fuel', reason: 'rule' })
  })

  it('matches case-insensitively as a substring of the payee', () => {
    expect(classify('   initech MARKET downtown ', RULES).category).toBe('Groceries')
  })

  it('leaves an unmatched payee uncategorized with reason "unmatched"', () => {
    expect(classify('Some Brand-New Vendor', RULES)).toEqual({ category: null, reason: 'unmatched' })
  })

  it('leaves a transfer-like payee uncategorized (reason "transfer")', () => {
    expect(classify('ACME Card Payment', RULES)).toEqual({ category: null, reason: 'transfer' })
    expect(classify('Wayne P2P to a friend', RULES)).toEqual({ category: null, reason: 'transfer' })
  })

  it('leaves an investment-internal payee uncategorized (reason "investment")', () => {
    expect(classify('Globex Brokerage buy', RULES)).toEqual({ category: null, reason: 'investment' })
    expect(classify('Initech 401k contribution', RULES)).toEqual({ category: null, reason: 'investment' })
  })

  // The phantom-income guard (spec §5). This is the invariant the whole job exists to protect:
  // exclusions are evaluated BEFORE rules, so a transfer/investment payee is NEVER categorized
  // even if a category rule would otherwise match it.
  it('INVARIANT: a transfer/investment payee is never categorized even when a rule would match', () => {
    const trap = loadRules(`
exclude_transfer:   [ "hooli gas" ]
exclude_investment: [ "umbrella foods" ]
rules:
  - category: Fuel
    match: [ "hooli gas" ]
  - category: Groceries
    match: [ "umbrella foods" ]
`)
    // Both payees match a category rule, but each is also excluded → must stay null.
    expect(classify('Hooli Gas', trap)).toEqual({ category: null, reason: 'transfer' })
    expect(classify('Umbrella Foods', trap)).toEqual({ category: null, reason: 'investment' })
  })

  it('treats an empty or whitespace payee as unmatched', () => {
    expect(classify('', RULES)).toEqual({ category: null, reason: 'unmatched' })
    expect(classify('   ', RULES)).toEqual({ category: null, reason: 'unmatched' })
  })
})
