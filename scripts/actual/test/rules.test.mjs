import { describe, it, expect } from 'vitest'
import { loadRules } from '../lib/rules.mjs'

// Synthetic payees only — never real merchant names (repo is PUBLIC; data rule).

describe('loadRules', () => {
  it('parses a well-formed rules document', () => {
    const yaml = `
exclude_transfer: [ "acme card payment" ]
exclude_investment: [ "globex brokerage" ]
rules:
  - category: Groceries
    match: [ "initech market", "umbrella foods" ]
  - category: Fuel
    match: [ "hooli gas" ]
`
    const rules = loadRules(yaml)
    expect(rules.exclude_transfer).toEqual(['acme card payment'])
    expect(rules.exclude_investment).toEqual(['globex brokerage'])
    expect(rules.rules).toHaveLength(2)
    expect(rules.rules[0]).toEqual({ category: 'Groceries', match: ['initech market', 'umbrella foods'] })
  })

  it('lowercases match substrings and exclusions defensively', () => {
    const yaml = `
exclude_transfer: [ "ACME Card Payment" ]
rules:
  - category: Fuel
    match: [ "Hooli GAS" ]
`
    const rules = loadRules(yaml)
    expect(rules.exclude_transfer).toEqual(['acme card payment'])
    expect(rules.rules[0].match).toEqual(['hooli gas'])
  })

  it('defaults both exclusion lists to [] when absent', () => {
    const rules = loadRules(`rules:\n  - category: Fuel\n    match: [ "hooli gas" ]\n`)
    expect(rules.exclude_transfer).toEqual([])
    expect(rules.exclude_investment).toEqual([])
  })

  it('throws on malformed YAML', () => {
    expect(() => loadRules('rules: [ : : : ]')).toThrow()
  })

  it('throws when the top-level document is not a mapping', () => {
    expect(() => loadRules('- just\n- a\n- list\n')).toThrow(/rules file/i)
  })

  it('throws when `rules` is missing or not an array', () => {
    expect(() => loadRules('exclude_transfer: []\n')).toThrow(/rules/i)
    expect(() => loadRules('rules: not-a-list\n')).toThrow(/rules/i)
  })

  it('throws when a rule is missing category', () => {
    expect(() => loadRules('rules:\n  - match: [ "x" ]\n')).toThrow(/category/i)
  })

  it('throws when a rule has an empty or missing match list', () => {
    expect(() => loadRules('rules:\n  - category: Fuel\n')).toThrow(/match/i)
    expect(() => loadRules('rules:\n  - category: Fuel\n    match: []\n')).toThrow(/match/i)
  })
})
