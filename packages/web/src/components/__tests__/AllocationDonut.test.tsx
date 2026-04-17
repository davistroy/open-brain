import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AllocationDonut } from '../AllocationDonut'

describe('AllocationDonut', () => {
  it('renders empty state when holdings is empty', () => {
    render(<AllocationDonut holdings={[]} />)
    expect(screen.getByText(/no holdings data/i)).toBeInTheDocument()
  })

  it('renders empty state when all market_values are zero', () => {
    render(
      <AllocationDonut
        holdings={[
          { symbol: 'AAPL', market_value: 0, asset_type: 'Equity' },
          { symbol: 'MSFT', market_value: 0, asset_type: 'Equity' },
        ]}
      />,
    )
    expect(screen.getByText(/no holdings data/i)).toBeInTheDocument()
  })

  it('renders a donut + legend when holdings have value', () => {
    render(
      <AllocationDonut
        holdings={[
          { symbol: 'AAPL', market_value: 1000, asset_type: 'Equity' },
          { symbol: 'AGG', market_value: 500, asset_type: 'Fixed Income' },
        ]}
      />,
    )
    // Legend entries
    expect(screen.getByText('Equity')).toBeInTheDocument()
    expect(screen.getByText('Fixed Income')).toBeInTheDocument()
  })
})
