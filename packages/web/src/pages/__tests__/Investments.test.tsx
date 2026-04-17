import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/lib/api', () => ({
  investmentsApi: {
    latestBalances: vi.fn(),
    balanceHistory: vi.fn(),
    latestPositions: vi.fn(),
  },
}))

import { investmentsApi } from '@/lib/api'
import { Investments } from '../Investments'

describe('Investments page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the empty-state CTA when no Schwab data is available', async () => {
    ;(investmentsApi.latestBalances as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(investmentsApi.balanceHistory as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(investmentsApi.latestPositions as ReturnType<typeof vi.fn>).mockResolvedValue([])

    render(
      <MemoryRouter>
        <Investments />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(
        screen.getByText(/drop a schwab balances or positions csv/i),
      ).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /ingest/i })).toBeInTheDocument()
  })

  it('renders error state when a call rejects', async () => {
    ;(investmentsApi.latestBalances as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    )
    ;(investmentsApi.balanceHistory as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(investmentsApi.latestPositions as ReturnType<typeof vi.fn>).mockResolvedValue([])

    render(
      <MemoryRouter>
        <Investments />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByText(/failed to load investment data/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
