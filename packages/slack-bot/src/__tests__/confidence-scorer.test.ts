import { describe, it, expect } from 'vitest'
import { scoreConfidence } from '../services/confidence-scorer.js'
import type { SearchResult } from '../lib/core-api-types.js'

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: '1',
    content: 'test content',
    score: 0.5,
    created_at: new Date().toISOString(),
    capture_type: 'observation',
    brain_view: 'technical',
    source: 'api',
    ...overrides,
  }
}

describe('scoreConfidence', () => {
  it('caps search score at 1.0', () => {
    const results = [makeResult({ score: 1.5 })]
    const { searchScore } = scoreConfidence(results)
    expect(searchScore).toBeLessThanOrEqual(1)
  })

  it('recency favors recent results', () => {
    const recent = [makeResult({ score: 0.5, created_at: new Date().toISOString() })]
    const old = [makeResult({ score: 0.5, created_at: '2025-01-01T00:00:00Z' })]
    const recentConf = scoreConfidence(recent)
    const oldConf = scoreConfidence(old)
    expect(recentConf.composite).toBeGreaterThan(oldConf.composite)
  })

  it('coverage score caps at 5 relevant results', () => {
    const fiveResults = Array.from({ length: 5 }, (_, i) =>
      makeResult({ id: String(i), score: 0.5 }),
    )
    const tenResults = Array.from({ length: 10 }, (_, i) =>
      makeResult({ id: String(i), score: 0.5 }),
    )
    const conf5 = scoreConfidence(fiveResults)
    const conf10 = scoreConfidence(tenResults)
    // Coverage should be the same (capped at 5)
    expect(conf5.composite).toBe(conf10.composite)
  })

  it('returns zero composite for empty results', () => {
    expect(scoreConfidence([]).composite).toBe(0)
  })

  it('returns 999 avgAgeDays for empty results', () => {
    expect(scoreConfidence([]).avgAgeDays).toBe(999)
  })

  it('composite is weighted sum: 0.5 * search + 0.3 * coverage + 0.2 * recency', () => {
    // Single result with score 1.0 and very recent date
    const results = [makeResult({ score: 1.0, created_at: new Date().toISOString() })]
    const conf = scoreConfidence(results)
    // search = 1.0, coverage = 1/5 = 0.2, recency ~ 1.0
    // composite ~ 0.5 * 1.0 + 0.3 * 0.2 + 0.2 * 1.0 = 0.76
    expect(conf.composite).toBeGreaterThan(0.7)
    expect(conf.composite).toBeLessThan(0.8)
  })

  it('counts only results with score > 0.3 as relevant', () => {
    const results = [
      makeResult({ id: '1', score: 0.8 }),
      makeResult({ id: '2', score: 0.4 }),
      makeResult({ id: '3', score: 0.2 }), // below threshold
      makeResult({ id: '4', score: 0.1 }), // below threshold
    ]
    const conf = scoreConfidence(results)
    expect(conf.relevantResultCount).toBe(2)
  })
})
