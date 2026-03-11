import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DriftCard from '../DriftCard'
import type { IntelligenceEntry } from '@/lib/api'

function makeEntry(overrides: Partial<IntelligenceEntry> = {}): IntelligenceEntry {
  return {
    id: 'drift-1',
    skill_name: 'drift-monitor',
    capture_id: null,
    input_summary: null,
    output_summary: 'Drift analysis complete',
    result: null,
    duration_ms: 3400,
    created_at: '2026-03-10T08:00:00Z',
    ...overrides,
  }
}

describe('DriftCard', () => {
  // ---------- severity badges ----------

  it('renders severity badges correctly for each drift item', () => {
    const entry = makeEntry({
      result: {
        summary: 'Found 3 items drifting',
        drift_items: [
          {
            item_type: 'bet',
            item_name: 'AI adoption bet',
            severity: 'high',
            days_silent: 14,
            reason: 'No captures mentioning this bet in 2 weeks',
            suggested_action: 'Review bet status',
          },
          {
            item_type: 'commitment',
            item_name: 'Weekly governance session',
            severity: 'medium',
            days_silent: 7,
            reason: 'Missed last session',
            suggested_action: 'Schedule catch-up',
          },
          {
            item_type: 'entity',
            item_name: 'Kubernetes',
            severity: 'low',
            days_silent: 3,
            reason: 'Slight decline in mentions',
            suggested_action: 'Monitor',
          },
        ],
        overall_health: 'significant_drift',
      },
    })

    render(<DriftCard entry={entry} />)

    // Severity badges
    expect(screen.getByText('high')).toBeInTheDocument()
    expect(screen.getByText('medium')).toBeInTheDocument()
    expect(screen.getByText('low')).toBeInTheDocument()

    // Item names
    expect(screen.getByText('AI adoption bet')).toBeInTheDocument()
    expect(screen.getByText('Weekly governance session')).toBeInTheDocument()
    expect(screen.getByText('Kubernetes')).toBeInTheDocument()

    // Item type badges
    expect(screen.getByText('Bet')).toBeInTheDocument()
    expect(screen.getByText('Commitment')).toBeInTheDocument()
    expect(screen.getByText('Entity')).toBeInTheDocument()

    // Days silent
    expect(screen.getByText('14d silent')).toBeInTheDocument()
    expect(screen.getByText('7d silent')).toBeInTheDocument()
    expect(screen.getByText('3d silent')).toBeInTheDocument()

    // Reasons
    expect(screen.getByText('No captures mentioning this bet in 2 weeks')).toBeInTheDocument()

    // Suggested actions
    expect(screen.getByText(/Review bet status/)).toBeInTheDocument()
    expect(screen.getByText(/Schedule catch-up/)).toBeInTheDocument()
  })

  // ---------- health score rendering ----------

  it('renders overall health score badge', () => {
    const entry = makeEntry({
      result: {
        summary: 'All clear',
        drift_items: [],
        overall_health: 'healthy',
      },
    })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText('Healthy')).toBeInTheDocument()
  })

  it.each([
    ['minor_drift', 'Minor Drift'],
    ['significant_drift', 'Significant Drift'],
    ['critical_drift', 'Critical Drift'],
    ['healthy', 'Healthy'],
  ] as const)('renders health label "%s" as "%s"', (health, label) => {
    const entry = makeEntry({
      result: {
        summary: '',
        drift_items: [],
        overall_health: health,
      },
    })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText(label)).toBeInTheDocument()
  })

  // ---------- empty state (no drift items) ----------

  it('shows no-drift message when drift_items is empty', () => {
    const entry = makeEntry({
      result: {
        summary: 'Everything looks good',
        drift_items: [],
        overall_health: 'healthy',
      },
    })

    render(<DriftCard entry={entry} />)

    expect(
      screen.getByText('No drift items detected — all tracked items are active.'),
    ).toBeInTheDocument()
  })

  // ---------- null / missing result ----------

  it('shows empty state when result is null', () => {
    const entry = makeEntry({ result: null, output_summary: null })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText('No structured drift data available.')).toBeInTheDocument()
  })

  it('shows output_summary fallback when result is null but output_summary exists', () => {
    const entry = makeEntry({ result: null, output_summary: 'Drift summary text' })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText('Drift summary text')).toBeInTheDocument()
    expect(screen.queryByText('No structured drift data available.')).not.toBeInTheDocument()
  })

  // ---------- malformed result data ----------

  it('handles drift items with missing fields gracefully', () => {
    const entry = makeEntry({
      result: {
        summary: 'Partial',
        drift_items: [
          {
            // All fields missing — parser applies defaults
          },
        ],
        overall_health: 'minor_drift',
      },
    })

    render(<DriftCard entry={entry} />)

    // Defaults: item_name → '(unnamed)', severity → 'low', item_type → 'entity'
    expect(screen.getByText('(unnamed)')).toBeInTheDocument()
    expect(screen.getByText('low')).toBeInTheDocument()
    expect(screen.getByText('Entity')).toBeInTheDocument()
  })

  it('handles unknown overall_health value by defaulting to healthy', () => {
    const entry = makeEntry({
      result: {
        summary: '',
        drift_items: [],
        overall_health: 'unknown_value',
      },
    })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText('Healthy')).toBeInTheDocument()
  })

  it('handles non-object result gracefully', () => {
    const entry = makeEntry({
      result: 42 as unknown as Record<string, unknown>,
      output_summary: null,
    })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText('No structured drift data available.')).toBeInTheDocument()
  })

  // ---------- items detected count ----------

  it('renders item count text for multiple drift items', () => {
    const entry = makeEntry({
      result: {
        summary: '',
        drift_items: [
          { item_type: 'bet', item_name: 'A', severity: 'high', days_silent: 10, reason: '', suggested_action: '' },
          { item_type: 'bet', item_name: 'B', severity: 'medium', days_silent: 5, reason: '', suggested_action: '' },
        ],
        overall_health: 'significant_drift',
      },
    })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText('2 items detected')).toBeInTheDocument()
  })

  it('renders singular item count for single drift item', () => {
    const entry = makeEntry({
      result: {
        summary: '',
        drift_items: [
          { item_type: 'entity', item_name: 'React', severity: 'low', days_silent: 2, reason: '', suggested_action: '' },
        ],
        overall_health: 'minor_drift',
      },
    })

    render(<DriftCard entry={entry} />)

    expect(screen.getByText('1 item detected')).toBeInTheDocument()
  })

  // ---------- days_silent = 0 is not shown ----------

  it('does not render days silent when value is 0', () => {
    const entry = makeEntry({
      result: {
        summary: '',
        drift_items: [
          { item_type: 'bet', item_name: 'Fresh bet', severity: 'low', days_silent: 0, reason: '', suggested_action: '' },
        ],
        overall_health: 'healthy',
      },
    })

    render(<DriftCard entry={entry} />)

    expect(screen.queryByText(/0d silent/)).not.toBeInTheDocument()
  })
})
