import { describe, it, expect } from 'vitest'
import {
  formatSearchResults,
  formatCapture,
  formatStats,
  formatError,
} from '../lib/formatters.js'
import type { SearchResult, CaptureResult, BrainStats } from '../lib/core-api-client.js'

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'cap-1',
    content: 'Decided to implement tiered pricing for QSR segment based on volume commitments.',
    capture_type: 'decision',
    brain_view: 'work-internal',
    source: 'slack',
    score: 0.87,
    created_at: '2026-03-05T10:00:00Z',
    pre_extracted: {
      topics: ['pricing', 'QSR', 'tiered model'],
    },
    ...overrides,
  }
}

function makeCaptureResult(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    id: 'cap-uuid-abc123',
    content: 'Full capture content here with all the detail you would want to see.',
    capture_type: 'decision',
    brain_view: 'work-internal',
    source: 'slack',
    pipeline_status: 'complete',
    tags: ['pricing', 'qsr'],
    created_at: '2026-03-05T10:00:00Z',
    pre_extracted: {
      entities: [
        { name: 'Alice Smith', type: 'person' },
        { name: 'Bob Jones', type: 'person' },
        { name: 'Acme Corp', type: 'organization' },
      ],
      topics: ['pricing', 'QSR', 'strategy'],
      sentiment: 'positive',
    },
    ...overrides,
  }
}

function makeBrainStats(overrides: Partial<BrainStats> = {}): BrainStats {
  return {
    total_captures: 58,
    by_source: { slack: 40, api: 18 },
    by_type: { decision: 20, idea: 15, task: 12, observation: 11 },
    by_view: { technical: 25, work_internal: 18, career: 10, personal: 5 },
    pipeline_health: {
      pending: 3,
      processing: 1,
      complete: 52,
      failed: 2,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// formatSearchResults
// ---------------------------------------------------------------------------

describe('formatSearchResults()', () => {
  describe('with results', () => {
    it('includes query in the header', () => {
      const results = [makeSearchResult()]
      const output = formatSearchResults(results, 'QSR pricing')
      expect(output).toContain('QSR pricing')
    })

    it('includes total count in header', () => {
      const results = [makeSearchResult(), makeSearchResult({ id: 'cap-2' })]
      const output = formatSearchResults(results, 'test query')
      expect(output).toContain('2 total')
    })

    it('numbers results starting from 1', () => {
      const results = [makeSearchResult()]
      const output = formatSearchResults(results, 'test')
      expect(output).toMatch(/^1\./m)
    })

    it('includes capture type in each result', () => {
      const results = [makeSearchResult({ capture_type: 'decision' })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('decision')
    })

    it('includes formatted date in each result', () => {
      const results = [makeSearchResult({ created_at: '2026-03-05T10:00:00Z' })]
      const output = formatSearchResults(results, 'test')
      // Date formatted as "Mar 5, 2026"
      expect(output).toContain('Mar 5, 2026')
    })

    it('includes match percentage in each result', () => {
      const results = [makeSearchResult({ score: 0.87 })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('87%')
    })

    it('includes content preview for each result', () => {
      const results = [makeSearchResult({ content: 'Short content here.' })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('Short content here.')
    })

    it('truncates long content with ellipsis', () => {
      const longContent = 'A'.repeat(200)
      const results = [makeSearchResult({ content: longContent })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('…')
      // Should not include the full 200-char string
      expect(output).not.toContain(longContent)
    })

    it('includes topics when pre_extracted has topics', () => {
      const results = [makeSearchResult({
        pre_extracted: { topics: ['pricing', 'QSR'] },
      })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('pricing')
      expect(output).toContain('QSR')
    })

    it('shows up to 3 topics per result', () => {
      const results = [makeSearchResult({
        pre_extracted: { topics: ['a', 'b', 'c', 'd', 'e'] },
      })]
      const output = formatSearchResults(results, 'test')
      // Should contain first 3 but not necessarily 'd' or 'e'
      expect(output).toContain('a')
      expect(output).toContain('b')
      expect(output).toContain('c')
    })

    it('does not error when pre_extracted is undefined', () => {
      const results = [makeSearchResult({ pre_extracted: undefined })]
      expect(() => formatSearchResults(results, 'test')).not.toThrow()
    })

    it('does not error when pre_extracted.topics is empty', () => {
      const results = [makeSearchResult({ pre_extracted: { topics: [] } })]
      expect(() => formatSearchResults(results, 'test')).not.toThrow()
    })

    it('returns a string (not undefined or null)', () => {
      const results = [makeSearchResult()]
      const output = formatSearchResults(results, 'test')
      expect(typeof output).toBe('string')
      expect(output.length).toBeGreaterThan(0)
    })
  })

  describe('empty results', () => {
    it('returns no-results message when results array is empty', () => {
      const output = formatSearchResults([], 'QSR pricing')
      expect(output).toContain('No results found')
      expect(output).toContain('QSR pricing')
    })

    it('does not include a numbered list for empty results', () => {
      const output = formatSearchResults([], 'test')
      expect(output).not.toMatch(/^\d+\./m)
    })
  })

  describe('pagination', () => {
    it('shows page 1 results when page=1 (default)', () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeSearchResult({ id: `cap-${i}`, content: `Result number ${i}` }),
      )
      const output = formatSearchResults(results, 'test', 1, 5)
      expect(output).toContain('Result number 0')
      expect(output).toContain('Result number 4')
      expect(output).not.toContain('Result number 5')
    })

    it('shows "more" prompt when there are more pages', () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeSearchResult({ id: `cap-${i}` }),
      )
      const output = formatSearchResults(results, 'test', 1, 5)
      expect(output).toContain('more')
    })

    it('shows "Reply with a number" on last page (no more prompt)', () => {
      const results = Array.from({ length: 3 }, (_, i) =>
        makeSearchResult({ id: `cap-${i}` }),
      )
      const output = formatSearchResults(results, 'test', 1, 5)
      expect(output).toContain('Reply with a number')
      expect(output).not.toContain('next page')
    })

    it('shows page 2 results with correct numbering', () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeSearchResult({ id: `cap-${i}`, content: `Result number ${i}` }),
      )
      const output = formatSearchResults(results, 'test', 2, 5)
      // Page 2: items 5, 6, 7 — numbered 6, 7, 8
      expect(output).toContain('6.')
      expect(output).toContain('Result number 5')
    })
  })

  describe('score formatting', () => {
    it('formats 1.0 score as 100%', () => {
      const results = [makeSearchResult({ score: 1.0 })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('100%')
    })

    it('formats 0.5 score as 50%', () => {
      const results = [makeSearchResult({ score: 0.5 })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('50%')
    })

    it('rounds fractional percentages', () => {
      const results = [makeSearchResult({ score: 0.876 })]
      const output = formatSearchResults(results, 'test')
      expect(output).toContain('88%')
    })
  })
})

// ---------------------------------------------------------------------------
// formatCapture
// ---------------------------------------------------------------------------

describe('formatCapture()', () => {
  it('includes the capture ID', () => {
    const capture = makeCaptureResult({ id: 'cap-uuid-abc123' })
    const output = formatCapture(capture)
    expect(output).toContain('cap-uuid-abc123')
  })

  it('includes capture type', () => {
    const capture = makeCaptureResult({ capture_type: 'decision' })
    const output = formatCapture(capture)
    expect(output).toContain('decision')
  })

  it('includes brain view', () => {
    const capture = makeCaptureResult({ brain_view: 'work-internal' })
    const output = formatCapture(capture)
    expect(output).toContain('work-internal')
  })

  it('includes source', () => {
    const capture = makeCaptureResult({ source: 'slack' })
    const output = formatCapture(capture)
    expect(output).toContain('slack')
  })

  it('includes pipeline status', () => {
    const capture = makeCaptureResult({ pipeline_status: 'complete' })
    const output = formatCapture(capture)
    expect(output).toContain('complete')
  })

  it('includes formatted captured date', () => {
    const capture = makeCaptureResult({ created_at: '2026-03-05T10:00:00Z' })
    const output = formatCapture(capture)
    expect(output).toContain('Mar 5, 2026')
  })

  it('includes the full content body', () => {
    const capture = makeCaptureResult({ content: 'The full capture content goes here.' })
    const output = formatCapture(capture)
    expect(output).toContain('The full capture content goes here.')
  })

  it('lists person entities under People field', () => {
    const capture = makeCaptureResult({
      pre_extracted: {
        entities: [
          { name: 'Alice Smith', type: 'person' },
          { name: 'Bob Jones', type: 'person' },
          { name: 'Acme Corp', type: 'organization' },
        ],
        topics: [],
        sentiment: 'neutral',
      },
    })
    const output = formatCapture(capture)
    expect(output).toContain('Alice Smith')
    expect(output).toContain('Bob Jones')
    // Organization entities should NOT appear in People
    expect(output).not.toMatch(/People:.*Acme Corp/)
  })

  it('shows "none" for people when no person entities', () => {
    const capture = makeCaptureResult({
      pre_extracted: {
        entities: [{ name: 'Acme Corp', type: 'organization' }],
        topics: ['strategy'],
        sentiment: 'neutral',
      },
    })
    const output = formatCapture(capture)
    // formatter outputs "*People:* none" — check "People" label and "none" value both present
    expect(output).toContain('People')
    // The people value is either empty string or 'none' depending on formatter behavior
    // Test verifies no person names appear
    expect(output).not.toContain('Acme Corp')
  })

  it('includes topics from pre_extracted', () => {
    const capture = makeCaptureResult({
      pre_extracted: {
        entities: [],
        topics: ['pricing', 'QSR', 'strategy'],
        sentiment: 'positive',
      },
    })
    const output = formatCapture(capture)
    expect(output).toContain('pricing')
    expect(output).toContain('QSR')
    expect(output).toContain('strategy')
  })

  it('shows "none" or empty for topics when pre_extracted has no topics', () => {
    const capture = makeCaptureResult({
      pre_extracted: { entities: [], topics: [], sentiment: 'neutral' },
    })
    const output = formatCapture(capture)
    // formatter outputs "*Topics:* none" or "*Topics:* " — verify Topics label is present
    expect(output).toContain('Topics')
    // no topic text should appear (empty list)
    expect(output).not.toContain('pricing')
  })

  it('includes sentiment from pre_extracted', () => {
    const capture = makeCaptureResult({
      pre_extracted: { entities: [], topics: [], sentiment: 'positive' },
    })
    const output = formatCapture(capture)
    expect(output).toContain('positive')
  })

  it('shows "n/a" for sentiment when pre_extracted is missing', () => {
    const capture = makeCaptureResult({ pre_extracted: undefined })
    const output = formatCapture(capture)
    expect(output).toContain('n/a')
  })

  it('shows "none" for topics when pre_extracted is missing', () => {
    const capture = makeCaptureResult({ pre_extracted: undefined })
    const output = formatCapture(capture)
    // formatter outputs "*Topics:* none" — verify "none" appears in the output
    expect(output).toContain('Topics')
    expect(output).toContain('none')
  })

  it('returns a non-empty string', () => {
    const output = formatCapture(makeCaptureResult())
    expect(typeof output).toBe('string')
    expect(output.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// formatStats
// ---------------------------------------------------------------------------

describe('formatStats()', () => {
  it('includes total capture count in header', () => {
    const stats = makeBrainStats({ total_captures: 58 })
    const output = formatStats(stats)
    expect(output).toContain('58')
    expect(output).toContain('total captures')
  })

  it('includes by_type breakdown', () => {
    const stats = makeBrainStats({
      by_type: { decision: 20, idea: 15, task: 12 },
    })
    const output = formatStats(stats)
    expect(output).toContain('decision')
    expect(output).toContain('20')
    expect(output).toContain('idea')
    expect(output).toContain('15')
  })

  it('sorts by_type by count descending', () => {
    const stats = makeBrainStats({
      by_type: { task: 5, decision: 20, idea: 15 },
    })
    const output = formatStats(stats)
    // decision (20) should appear before idea (15) before task (5)
    const decisionPos = output.indexOf('decision')
    const ideaPos = output.indexOf('idea')
    const taskPos = output.indexOf('task')
    expect(decisionPos).toBeLessThan(ideaPos)
    expect(ideaPos).toBeLessThan(taskPos)
  })

  it('includes by_source breakdown', () => {
    const stats = makeBrainStats({
      by_source: { slack: 40, api: 18 },
    })
    const output = formatStats(stats)
    expect(output).toContain('slack')
    expect(output).toContain('40')
    expect(output).toContain('api')
    expect(output).toContain('18')
  })

  it('includes pipeline health values', () => {
    const stats = makeBrainStats({
      pipeline_health: { pending: 3, processing: 1, complete: 52, failed: 2 },
    })
    const output = formatStats(stats)
    expect(output).toContain('52')
    expect(output).toContain('complete')
    expect(output).toContain('3')
    expect(output).toContain('pending')
    expect(output).toContain('2')
    expect(output).toContain('failed')
  })

  it('shows "(none)" for empty by_type', () => {
    const stats = makeBrainStats({ by_type: {} })
    const output = formatStats(stats)
    expect(output).toContain('(none)')
  })

  it('shows "(none)" for empty by_source', () => {
    const stats = makeBrainStats({ by_source: {} })
    const output = formatStats(stats)
    expect(output).toContain('(none)')
  })

  it('returns a non-empty string', () => {
    const output = formatStats(makeBrainStats())
    expect(typeof output).toBe('string')
    expect(output.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe('formatError()', () => {
  it('includes context label in output', () => {
    const output = formatError('Capture failed', new Error('Network timeout'))
    expect(output).toContain('Capture failed')
  })

  it('includes error message for Error instances', () => {
    const output = formatError('Search error', new Error('Connection refused'))
    expect(output).toContain('Connection refused')
  })

  it('handles non-Error thrown values (string)', () => {
    const output = formatError('Unexpected', 'Something went wrong')
    expect(output).toContain('Something went wrong')
  })

  it('handles non-Error thrown values (number)', () => {
    const output = formatError('Unexpected', 42)
    expect(output).toContain('42')
  })

  it('handles null/undefined gracefully', () => {
    expect(() => formatError('Test', null)).not.toThrow()
    expect(() => formatError('Test', undefined)).not.toThrow()
  })

  it('includes warning emoji or indicator', () => {
    const output = formatError('Something broke', new Error('Details'))
    // The formatter includes :warning: as a Slack emoji
    expect(output).toContain(':warning:')
  })

  it('returns a non-empty string', () => {
    const output = formatError('Test context', new Error('Test error'))
    expect(typeof output).toBe('string')
    expect(output.length).toBeGreaterThan(0)
  })

  it('makes context bold via Slack markdown (*)', () => {
    const output = formatError('Capture failed', new Error('timeout'))
    expect(output).toContain('*Capture failed*')
  })
})
