import { describe, it, expect, vi } from 'vitest'
import { isAutoResponseCandidate, type AutoResponseConfig } from '../handlers/auto-response.js'
import { scoreConfidence } from '../services/confidence-scorer.js'
import { formatAttributedResponse } from '../services/attribution-formatter.js'
import type { SearchResult } from '../lib/core-api-types.js'

const baseConfig: AutoResponseConfig = {
  coreApiUrl: 'http://localhost:3000',
  confidenceThreshold: 0.6,
  stalenessDays: 90,
  minCorroboratingResults: 2,
  botUserId: 'B123',
  ownerUserId: 'U_OWNER',
}

describe('isAutoResponseCandidate', () => {
  const makeMessage = (text: string, user = 'U_OTHER') =>
    ({
      text,
      user,
      channel: 'C123',
      ts: '1234.5678',
      type: 'message' as const,
    }) as any

  it('returns true for questions from other users', () => {
    expect(isAutoResponseCandidate(makeMessage('What is the status of project X?'), baseConfig)).toBe(true)
    expect(isAutoResponseCandidate(makeMessage('How do we handle auth in the new system?'), baseConfig)).toBe(true)
    expect(isAutoResponseCandidate(makeMessage('Does anyone know the deploy process?'), baseConfig)).toBe(true)
  })

  it('returns true for messages ending with question mark', () => {
    expect(isAutoResponseCandidate(makeMessage('The deploy is broken again?'), baseConfig)).toBe(true)
  })

  it('returns false for owner messages', () => {
    expect(isAutoResponseCandidate(makeMessage('What is the plan?', 'U_OWNER'), baseConfig)).toBe(false)
  })

  it('returns false for bot messages', () => {
    expect(isAutoResponseCandidate(makeMessage('What is happening?', 'B123'), baseConfig)).toBe(false)
  })

  it('returns false for short messages', () => {
    expect(isAutoResponseCandidate(makeMessage('hi?'), baseConfig)).toBe(false)
  })

  it('returns false for command/query prefixes', () => {
    expect(isAutoResponseCandidate(makeMessage('!stats something long enough'), baseConfig)).toBe(false)
    expect(isAutoResponseCandidate(makeMessage('?search something long enough'), baseConfig)).toBe(false)
  })

  it('returns false for non-question messages', () => {
    expect(isAutoResponseCandidate(makeMessage('I just pushed the new build'), baseConfig)).toBe(false)
    expect(isAutoResponseCandidate(makeMessage('Lunch at noon sounds good'), baseConfig)).toBe(false)
  })
})

describe('scoreConfidence', () => {
  it('returns zero for empty results', () => {
    const result = scoreConfidence([])
    expect(result.composite).toBe(0)
  })

  it('returns high confidence for strong results', () => {
    const results: SearchResult[] = [
      { id: '1', content: 'test', score: 0.9, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
      { id: '2', content: 'test2', score: 0.8, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
      { id: '3', content: 'test3', score: 0.7, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
    ]
    const result = scoreConfidence(results)
    expect(result.composite).toBeGreaterThan(0.6)
    expect(result.relevantResultCount).toBe(3)
  })

  it('returns low confidence for weak results', () => {
    const results: SearchResult[] = [
      { id: '1', content: 'test', score: 0.2, created_at: '2025-01-01T00:00:00Z', capture_type: 'observation', brain_view: 'technical', source: 'api' },
    ]
    const result = scoreConfidence(results)
    expect(result.composite).toBeLessThan(0.3)
  })
})

describe('formatAttributedResponse', () => {
  it('formats synthesis with sources', () => {
    const results: SearchResult[] = [
      {
        id: '1',
        content: 'The deploy process uses Docker Compose',
        score: 0.9,
        created_at: '2026-04-01T00:00:00Z',
        source: 'slack',
        capture_type: 'decision',
        brain_view: 'technical',
      },
    ]
    const response = formatAttributedResponse('We use Docker Compose for deploys.', results)
    expect(response.text).toContain('Based on captured context')
    expect(response.text).toContain('Docker Compose for deploys')
    expect(response.text).toContain('AI-generated')
    expect(response.sources).toHaveLength(1)
    expect(response.sources[0].source).toBe('slack')
  })

  it('limits sources to maxSources', () => {
    const results: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      content: `capture ${i}`,
      score: 0.5,
      created_at: '2026-04-01T00:00:00Z',
      source: 'api',
      capture_type: 'observation',
      brain_view: 'technical',
    }))
    const response = formatAttributedResponse('test', results, { maxSources: 2 })
    expect(response.sources).toHaveLength(2)
  })

  it('truncates long synthesis in summary', () => {
    const longText = 'A'.repeat(300)
    const results: SearchResult[] = [
      { id: '1', content: 'test', score: 0.9, created_at: '2026-04-01T00:00:00Z', source: 'api', capture_type: 'observation', brain_view: 'technical' },
    ]
    const response = formatAttributedResponse(longText, results)
    expect(response.summary.length).toBeLessThanOrEqual(203) // 200 + '...'
    expect(response.summary).toContain('...')
  })

  it('truncates long content excerpts', () => {
    const longContent = 'B'.repeat(100)
    const results: SearchResult[] = [
      { id: '1', content: longContent, score: 0.9, created_at: '2026-04-01T00:00:00Z', source: 'slack', capture_type: 'observation', brain_view: 'technical' },
    ]
    const response = formatAttributedResponse('test', results)
    expect(response.sources[0].excerpt.length).toBeLessThanOrEqual(83) // 80 + '...'
  })
})
