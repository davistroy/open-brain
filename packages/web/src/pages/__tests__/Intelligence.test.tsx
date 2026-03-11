import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock the API module before importing Intelligence
vi.mock('../../lib/api', () => ({
  intelligenceApi: {
    summary: vi.fn(),
    connectionsHistory: vi.fn(),
    driftHistory: vi.fn(),
    trigger: vi.fn(),
  },
}))

// Stub global EventSource so sse.ts module initialisation doesn't throw
class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
  onerror = null
}
vi.stubGlobal('EventSource', NoopEventSource)

import Intelligence from '../Intelligence'
import { intelligenceApi } from '../../lib/api'

function renderIntelligence() {
  return render(
    <MemoryRouter>
      <Intelligence />
    </MemoryRouter>,
  )
}

const mockConnectionsEntry = {
  id: 'conn-1',
  skill_name: 'daily-connections',
  capture_id: 'cap-1',
  input_summary: null,
  output_summary: 'Found 3 cross-domain patterns',
  result: {
    summary: 'Cross-domain patterns detected',
    connections: [
      {
        theme: 'AI + Operations',
        captures: ['c1', 'c2'],
        insight: 'Supply chain parallels',
        confidence: 'high',
        domains: ['technical', 'client'],
      },
    ],
    meta_pattern: null,
  },
  duration_ms: 5200,
  created_at: '2026-03-10T21:00:00Z',
}

const mockDriftEntry = {
  id: 'drift-1',
  skill_name: 'drift-monitor',
  capture_id: 'cap-2',
  input_summary: null,
  output_summary: 'No significant drift detected',
  result: {
    summary: 'All clear',
    drift_items: [],
    overall_health: 'healthy',
  },
  duration_ms: 3400,
  created_at: '2026-03-10T08:00:00Z',
}

describe('Intelligence page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---------- renders both cards ----------

  it('renders both Connections and Drift Monitor sections with data', async () => {
    vi.mocked(intelligenceApi.summary).mockResolvedValue({
      connections: mockConnectionsEntry,
      drift: mockDriftEntry,
    })

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByText('Connections')).toBeInTheDocument()
      expect(screen.getByText('Drift Monitor')).toBeInTheDocument()
    })

    // Connections card content renders
    expect(screen.getByText('Cross-domain patterns detected')).toBeInTheDocument()

    // Drift card content renders
    expect(screen.getByText('Healthy')).toBeInTheDocument()
  })

  // ---------- loading state ----------

  it('renders loading skeleton initially', () => {
    // Never resolve the promise to keep in loading state
    vi.mocked(intelligenceApi.summary).mockReturnValue(new Promise(() => {}))

    renderIntelligence()

    // Title should be visible even during loading
    expect(screen.getByText('Intelligence')).toBeInTheDocument()
  })

  // ---------- error state ----------

  it('renders error message when API fails', async () => {
    vi.mocked(intelligenceApi.summary).mockRejectedValue(new Error('API 500: Internal Server Error'))

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByText('API 500: Internal Server Error')).toBeInTheDocument()
    })
  })

  it('renders generic error for non-Error throws', async () => {
    vi.mocked(intelligenceApi.summary).mockRejectedValue('kaboom')

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByText('Failed to load intelligence data')).toBeInTheDocument()
    })
  })

  // ---------- empty states (no data yet) ----------

  it('renders empty states when both connections and drift are null', async () => {
    vi.mocked(intelligenceApi.summary).mockResolvedValue({
      connections: null,
      drift: null,
    })

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByText('No connections analysis yet.')).toBeInTheDocument()
      expect(screen.getByText('No drift analysis yet.')).toBeInTheDocument()
    })
  })

  // ---------- page heading and description ----------

  it('renders page heading and description after load', async () => {
    vi.mocked(intelligenceApi.summary).mockResolvedValue({
      connections: null,
      drift: null,
    })

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByText('Intelligence')).toBeInTheDocument()
      expect(screen.getByText('Daily connections and drift monitoring insights')).toBeInTheDocument()
    })
  })

  // ---------- Refresh button ----------

  it('renders Refresh button', async () => {
    vi.mocked(intelligenceApi.summary).mockResolvedValue({
      connections: null,
      drift: null,
    })

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })

  // ---------- Run buttons ----------

  it('renders Run buttons for both skills', async () => {
    vi.mocked(intelligenceApi.summary).mockResolvedValue({
      connections: mockConnectionsEntry,
      drift: mockDriftEntry,
    })

    renderIntelligence()

    await waitFor(() => {
      const runButtons = screen.getAllByRole('button', { name: /run/i })
      // Two Run buttons (connections + drift)
      expect(runButtons.length).toBe(2)
    })
  })

  // ---------- partial data ----------

  it('renders when only connections data available', async () => {
    vi.mocked(intelligenceApi.summary).mockResolvedValue({
      connections: mockConnectionsEntry,
      drift: null,
    })

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByText('Cross-domain patterns detected')).toBeInTheDocument()
      expect(screen.getByText('No drift analysis yet.')).toBeInTheDocument()
    })
  })

  it('renders when only drift data available', async () => {
    vi.mocked(intelligenceApi.summary).mockResolvedValue({
      connections: null,
      drift: mockDriftEntry,
    })

    renderIntelligence()

    await waitFor(() => {
      expect(screen.getByText('No connections analysis yet.')).toBeInTheDocument()
      expect(screen.getByText('Healthy')).toBeInTheDocument()
    })
  })
})
