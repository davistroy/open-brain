import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NetWorthChart } from '../NetWorthChart'
import type { SchwabSnapshotRecord } from '@/lib/api'

function record(overrides: Partial<SchwabSnapshotRecord>): SchwabSnapshotRecord {
  return {
    capture_id: 'cap-1',
    created_at: '2026-01-01T00:00:00Z',
    account_name: 'Contributory',
    account_mask: '1234',
    as_of: '2026-01-01',
    account_value: 100000,
    cash_value: 1000,
    market_value: 99000,
    day_change: 0,
    day_change_pct: '0%',
    ...overrides,
  }
}

describe('NetWorthChart', () => {
  it('renders empty state with no snapshots', () => {
    render(<NetWorthChart snapshots={[]} />)
    expect(screen.getByText(/need ≥2 snapshots/i)).toBeInTheDocument()
  })

  it('renders empty state with only one snapshot', () => {
    render(<NetWorthChart snapshots={[record({ capture_id: 'a' })]} />)
    expect(screen.getByText(/need ≥2 snapshots/i)).toBeInTheDocument()
  })

  it('renders a chart with legend when given enough snapshots', () => {
    render(
      <NetWorthChart
        snapshots={[
          record({
            capture_id: 'a',
            created_at: '2026-01-01T00:00:00Z',
            account_value: 100000,
          }),
          record({
            capture_id: 'b',
            created_at: '2026-02-01T00:00:00Z',
            account_value: 105000,
          }),
        ]}
      />,
    )
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('Contributory')).toBeInTheDocument()
  })
})
