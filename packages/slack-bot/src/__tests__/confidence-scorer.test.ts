import { describe, it, expect } from 'vitest'
import {
  scoreConfidence,
  extractQueryTerms,
  computeEntityMatchRatio,
  computeSourceDiversity,
} from '../services/confidence-scorer.js'
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

// --------------- extractQueryTerms ---------------

describe('extractQueryTerms', () => {
  it('removes stop words and lowercases', () => {
    const terms = extractQueryTerms('What is the status of project X?')
    expect(terms).not.toContain('what')
    expect(terms).not.toContain('is')
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('of')
    expect(terms).toContain('status')
    expect(terms).toContain('project')
  })

  it('returns empty for stop-word-only query', () => {
    expect(extractQueryTerms('what is the?')).toEqual([])
  })

  it('strips punctuation', () => {
    const terms = extractQueryTerms('How do we handle auth?')
    expect(terms).toContain('handle')
    expect(terms).toContain('auth')
  })

  it('filters single-char tokens', () => {
    const terms = extractQueryTerms('a b c deploy')
    expect(terms).toEqual(['deploy'])
  })
})

// --------------- computeEntityMatchRatio ---------------

describe('computeEntityMatchRatio', () => {
  it('returns 0 when no entities in results', () => {
    const results = [makeResult()]
    expect(computeEntityMatchRatio('deploy process', results)).toBe(0)
  })

  it('returns 0 for empty query terms (all stop words)', () => {
    const results = [makeResult({ pre_extracted: { entities: [{ name: 'Docker', type: 'tool' }] } })]
    expect(computeEntityMatchRatio('what is the?', results)).toBe(0)
  })

  it('returns 1.0 when all query terms match entities', () => {
    const results = [
      makeResult({
        pre_extracted: { entities: [{ name: 'Docker', type: 'tool' }, { name: 'deploy', type: 'process' }] },
      }),
    ]
    // "docker deploy" -> terms: ['docker', 'deploy'] -> both match entities
    expect(computeEntityMatchRatio('docker deploy', results)).toBe(1.0)
  })

  it('returns partial ratio for partial matches', () => {
    const results = [
      makeResult({
        pre_extracted: { entities: [{ name: 'Docker', type: 'tool' }] },
      }),
    ]
    // "docker compose setup" -> terms: ['docker', 'compose', 'setup'] -> 1 of 3 match
    const ratio = computeEntityMatchRatio('docker compose setup', results)
    expect(ratio).toBeCloseTo(1 / 3)
  })

  it('handles substring matching (entity name contains query term)', () => {
    const results = [
      makeResult({
        pre_extracted: { entities: [{ name: 'Kubernetes cluster', type: 'infrastructure' }] },
      }),
    ]
    // "kubernetes" is a substring of "kubernetes cluster"
    expect(computeEntityMatchRatio('kubernetes status', results)).toBeGreaterThan(0)
  })

  it('returns 0 for empty results array', () => {
    expect(computeEntityMatchRatio('docker deploy', [])).toBe(0)
  })

  it('collects entities across multiple results', () => {
    const results = [
      makeResult({
        id: '1',
        pre_extracted: { entities: [{ name: 'Docker', type: 'tool' }] },
      }),
      makeResult({
        id: '2',
        pre_extracted: { entities: [{ name: 'Compose', type: 'tool' }] },
      }),
    ]
    // Both "docker" and "compose" are found across the two results
    expect(computeEntityMatchRatio('docker compose', results)).toBe(1.0)
  })
})

// --------------- computeSourceDiversity ---------------

describe('computeSourceDiversity', () => {
  it('returns 0 for empty results', () => {
    expect(computeSourceDiversity([])).toBe(0)
  })

  it('returns 0.3 for single source', () => {
    expect(computeSourceDiversity([makeResult({ source: 'slack' })])).toBe(0.3)
  })

  it('returns 0.7 for two distinct sources', () => {
    const results = [
      makeResult({ id: '1', source: 'slack' }),
      makeResult({ id: '2', source: 'voice' }),
    ]
    expect(computeSourceDiversity(results)).toBe(0.7)
  })

  it('returns 1.0 for three or more distinct sources', () => {
    const results = [
      makeResult({ id: '1', source: 'slack' }),
      makeResult({ id: '2', source: 'voice' }),
      makeResult({ id: '3', source: 'email' }),
    ]
    expect(computeSourceDiversity(results)).toBe(1.0)
  })

  it('returns 1.0 for many distinct sources', () => {
    const results = [
      makeResult({ id: '1', source: 'slack' }),
      makeResult({ id: '2', source: 'voice' }),
      makeResult({ id: '3', source: 'email' }),
      makeResult({ id: '4', source: 'document' }),
      makeResult({ id: '5', source: 'api' }),
    ]
    expect(computeSourceDiversity(results)).toBe(1.0)
  })

  it('does not double-count same source type', () => {
    const results = [
      makeResult({ id: '1', source: 'slack' }),
      makeResult({ id: '2', source: 'slack' }),
      makeResult({ id: '3', source: 'slack' }),
    ]
    expect(computeSourceDiversity(results)).toBe(0.3)
  })

  it('only considers top 10 results', () => {
    // 11 results, all same source except the 11th
    const results = Array.from({ length: 11 }, (_, i) =>
      makeResult({ id: String(i), source: i < 10 ? 'slack' : 'email' }),
    )
    // Only top 10 are considered -- all slack
    expect(computeSourceDiversity(results)).toBe(0.3)
  })
})

// --------------- scoreConfidence (composite) ---------------

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
    // Corroboration capped at 5, source diversity same (all 'api')
    expect(conf5.composite).toBe(conf10.composite)
  })

  it('returns zero composite for empty results', () => {
    expect(scoreConfidence([]).composite).toBe(0)
  })

  it('returns 999 avgAgeDays for empty results', () => {
    expect(scoreConfidence([]).avgAgeDays).toBe(999)
  })

  it('returns 0 entityMatch and sourceDiversity for empty results', () => {
    const factors = scoreConfidence([])
    expect(factors.entityMatch).toBe(0)
    expect(factors.sourceDiversity).toBe(0)
  })

  it('composite uses 5-signal weights: 0.30 search + 0.25 entity + 0.20 recency + 0.15 corroboration + 0.10 diversity', () => {
    // Single recent result with score 1.0, no entities, single source
    const results = [makeResult({ score: 1.0, created_at: new Date().toISOString() })]
    const conf = scoreConfidence(results)
    // search = 1.0, entity = 0 (no query), recency ~ 1.0, corroboration = 1/5 = 0.2, diversity = 0.3
    // composite ~ 0.30*1.0 + 0.25*0 + 0.20*1.0 + 0.15*0.2 + 0.10*0.3 = 0.30 + 0.20 + 0.03 + 0.03 = 0.56
    expect(conf.composite).toBeGreaterThan(0.5)
    expect(conf.composite).toBeLessThan(0.6)
  })

  it('entity match signal boosts score when query matches result entities', () => {
    const results = [
      makeResult({
        score: 0.8,
        created_at: new Date().toISOString(),
        pre_extracted: { entities: [{ name: 'Docker', type: 'tool' }, { name: 'deploy', type: 'process' }] },
      }),
    ]
    const withEntity = scoreConfidence(results, 'docker deploy process')
    const withoutEntity = scoreConfidence(results)
    expect(withEntity.composite).toBeGreaterThan(withoutEntity.composite)
    expect(withEntity.entityMatch).toBeGreaterThan(0)
    expect(withoutEntity.entityMatch).toBe(0)
  })

  it('source diversity signal boosts multi-source results', () => {
    const singleSource = [
      makeResult({ id: '1', score: 0.8, source: 'slack', created_at: new Date().toISOString() }),
      makeResult({ id: '2', score: 0.7, source: 'slack', created_at: new Date().toISOString() }),
      makeResult({ id: '3', score: 0.6, source: 'slack', created_at: new Date().toISOString() }),
    ]
    const multiSource = [
      makeResult({ id: '1', score: 0.8, source: 'slack', created_at: new Date().toISOString() }),
      makeResult({ id: '2', score: 0.7, source: 'voice', created_at: new Date().toISOString() }),
      makeResult({ id: '3', score: 0.6, source: 'email', created_at: new Date().toISOString() }),
    ]
    const singleConf = scoreConfidence(singleSource)
    const multiConf = scoreConfidence(multiSource)
    expect(multiConf.composite).toBeGreaterThan(singleConf.composite)
    expect(multiConf.sourceDiversity).toBe(1.0)
    expect(singleConf.sourceDiversity).toBe(0.3)
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

  it('query parameter is optional (backward compatible)', () => {
    const results = [makeResult({ score: 0.8, created_at: new Date().toISOString() })]
    // Should not throw when query is omitted
    const conf = scoreConfidence(results)
    expect(conf.entityMatch).toBe(0)
    expect(conf.composite).toBeGreaterThan(0)
  })

  it('handles results with no pre_extracted data gracefully', () => {
    const results = [
      makeResult({ score: 0.8, created_at: new Date().toISOString() }),
    ]
    const conf = scoreConfidence(results, 'docker deploy')
    expect(conf.entityMatch).toBe(0)
    expect(conf.composite).toBeGreaterThan(0)
  })

  it('all five factors present in returned object', () => {
    const results = [makeResult({ score: 0.5 })]
    const conf = scoreConfidence(results, 'test query')
    expect(conf).toHaveProperty('searchScore')
    expect(conf).toHaveProperty('entityMatch')
    expect(conf).toHaveProperty('relevantResultCount')
    expect(conf).toHaveProperty('avgAgeDays')
    expect(conf).toHaveProperty('sourceDiversity')
    expect(conf).toHaveProperty('composite')
  })
})
