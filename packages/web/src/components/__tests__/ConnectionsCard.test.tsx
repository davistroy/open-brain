import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ConnectionsCard from '../ConnectionsCard'
import type { IntelligenceEntry } from '@/lib/api'

function makeEntry(overrides: Partial<IntelligenceEntry> = {}): IntelligenceEntry {
  return {
    id: 'entry-1',
    skill_name: 'daily-connections',
    capture_id: null,
    input_summary: null,
    output_summary: 'Found 3 connections across captures',
    result: null,
    duration_ms: 5200,
    created_at: '2026-03-10T21:00:00Z',
    ...overrides,
  }
}

describe('ConnectionsCard', () => {
  // ---------- structured connections rendering ----------

  it('renders structured connections with theme, insight, and confidence', () => {
    const entry = makeEntry({
      result: {
        summary: 'Cross-domain patterns detected',
        connections: [
          {
            theme: 'AI + Operations',
            captures: ['cap-1', 'cap-2'],
            insight: 'LLM orchestration mirrors supply chain routing',
            confidence: 'high',
            domains: ['technical', 'client'],
          },
          {
            theme: 'Career Leverage',
            captures: ['cap-3'],
            insight: 'Consulting frameworks apply to AI product pitches',
            confidence: 'medium',
            domains: ['career'],
          },
        ],
        meta_pattern: 'Systems-thinking thread across all domains',
      },
    })

    render(<ConnectionsCard entry={entry} />)

    // Summary text
    expect(screen.getByText('Cross-domain patterns detected')).toBeInTheDocument()

    // Connection themes
    expect(screen.getByText('AI + Operations')).toBeInTheDocument()
    expect(screen.getByText('Career Leverage')).toBeInTheDocument()

    // Insights
    expect(screen.getByText('LLM orchestration mirrors supply chain routing')).toBeInTheDocument()
    expect(screen.getByText('Consulting frameworks apply to AI product pitches')).toBeInTheDocument()

    // Confidence badges
    expect(screen.getByText('high')).toBeInTheDocument()
    expect(screen.getByText('medium')).toBeInTheDocument()

    // Domain badges
    expect(screen.getByText('technical')).toBeInTheDocument()
    expect(screen.getByText('client')).toBeInTheDocument()
    expect(screen.getByText('career')).toBeInTheDocument()

    // Cross-domain indicator (for connection with 2+ domains)
    expect(screen.getByText('cross-domain')).toBeInTheDocument()

    // Related captures count
    expect(screen.getByText('2 related captures')).toBeInTheDocument()
    expect(screen.getByText('1 related capture')).toBeInTheDocument()

    // Meta-pattern
    expect(screen.getByText('Meta-pattern')).toBeInTheDocument()
    expect(screen.getByText('Systems-thinking thread across all domains')).toBeInTheDocument()
  })

  // ---------- empty state ----------

  it('shows empty state when result is null', () => {
    const entry = makeEntry({ result: null, output_summary: null })

    render(<ConnectionsCard entry={entry} />)

    expect(screen.getByText('No structured connections data available.')).toBeInTheDocument()
  })

  it('shows output_summary fallback when result is null but output_summary exists', () => {
    const entry = makeEntry({ result: null, output_summary: 'Some text summary' })

    render(<ConnectionsCard entry={entry} />)

    expect(screen.getByText('Some text summary')).toBeInTheDocument()
    // Should NOT show the generic empty message
    expect(screen.queryByText('No structured connections data available.')).not.toBeInTheDocument()
  })

  it('shows empty state when connections array is empty', () => {
    const entry = makeEntry({
      result: { summary: '', connections: [], meta_pattern: null },
      output_summary: null,
    })

    render(<ConnectionsCard entry={entry} />)

    expect(screen.getByText('No structured connections data available.')).toBeInTheDocument()
  })

  // ---------- missing / malformed result data ----------

  it('handles result with no connections key', () => {
    const entry = makeEntry({
      result: { summary: 'Something', meta_pattern: null },
      output_summary: null,
    })

    render(<ConnectionsCard entry={entry} />)

    // No connections → falls through to empty state
    expect(screen.getByText('No structured connections data available.')).toBeInTheDocument()
  })

  it('handles connection items with missing fields gracefully', () => {
    const entry = makeEntry({
      result: {
        summary: 'Partial data',
        connections: [
          {
            // theme, captures, insight, confidence, domains all missing
          },
        ],
        meta_pattern: null,
      },
    })

    render(<ConnectionsCard entry={entry} />)

    // Defaults applied: theme → '(unnamed)', confidence → 'low'
    expect(screen.getByText('(unnamed)')).toBeInTheDocument()
    expect(screen.getByText('low')).toBeInTheDocument()
  })

  it('handles non-object result gracefully', () => {
    const entry = makeEntry({
      result: 'just a string' as unknown as Record<string, unknown>,
      output_summary: null,
    })

    render(<ConnectionsCard entry={entry} />)

    expect(screen.getByText('No structured connections data available.')).toBeInTheDocument()
  })

  // ---------- no meta_pattern ----------

  it('does not render meta-pattern section when null', () => {
    const entry = makeEntry({
      result: {
        summary: 'Summary here',
        connections: [
          {
            theme: 'Theme A',
            captures: [],
            insight: 'Insight A',
            confidence: 'low',
            domains: [],
          },
        ],
        meta_pattern: null,
      },
    })

    render(<ConnectionsCard entry={entry} />)

    expect(screen.queryByText('Meta-pattern')).not.toBeInTheDocument()
  })

  // ---------- single domain (no cross-domain badge) ----------

  it('does not render cross-domain badge for single-domain connection', () => {
    const entry = makeEntry({
      result: {
        summary: '',
        connections: [
          {
            theme: 'Focused',
            captures: [],
            insight: 'Single domain insight',
            confidence: 'high',
            domains: ['technical'],
          },
        ],
        meta_pattern: null,
      },
    })

    render(<ConnectionsCard entry={entry} />)

    expect(screen.getByText('technical')).toBeInTheDocument()
    expect(screen.queryByText('cross-domain')).not.toBeInTheDocument()
  })
})
