import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock the API module before importing Dashboard so all fetch calls are intercepted
vi.mock('../../lib/api', () => ({
  statsApi: {
    get: vi.fn().mockResolvedValue({
      total_captures: 5,
      by_source: {},
      by_type: {},
      by_view: {},
      pipeline_health: { queue_depth: 0, failed_jobs: 0, avg_processing_ms: 0 },
      embeddings_coverage: 1,
    }),
  },
  capturesApi: {
    list: vi.fn().mockResolvedValue({ data: [], total: 0, limit: 10, offset: 0 }),
  },
  pipelineApi: {
    health: vi.fn().mockResolvedValue({
      queues: { ingestion: { waiting: 0, active: 0, failed: 0 } },
    }),
  },
}))

// Also stub global EventSource so sse.ts module initialisation doesn't throw
class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
  onerror = null
}
vi.stubGlobal('EventSource', NoopEventSource)

import Dashboard from '../Dashboard'

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  )
}

describe('Dashboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Dashboard heading', async () => {
    renderDashboard()
    // heading visible after loading resolves
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument()
    })
  })

  it('renders the Quick Capture section', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('Quick Capture')).toBeInTheDocument()
    })
  })

  it('renders the Recent Captures section', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('Recent Captures')).toBeInTheDocument()
    })
  })

  it('shows the empty state when no captures are returned', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('No captures yet.')).toBeInTheDocument()
    })
  })

  it('renders the Refresh button', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })
})
