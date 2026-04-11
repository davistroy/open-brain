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
      pipeline_health: { pending: 0, processing: 0, complete: 5, failed: 0 },
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
  adminApi: {
    getBanner: vi.fn().mockResolvedValue({ banner: null }),
  },
  intelligenceApi: {
    unresolvedQuestions: vi.fn().mockResolvedValue({ questions: [], count: 0 }),
  },
  activityApi: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 30, offset: 0 }),
    countSince: vi.fn().mockResolvedValue(0),
  },
}))

// Mock the SSE module
vi.mock('../../lib/sse', () => ({
  sseClient: {
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
  },
  createSSEConnection: vi.fn().mockReturnValue(() => {}),
}))

// Also stub global EventSource so module initialisation doesn't throw
class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
  onerror = null
  onmessage = null
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

  it('renders the Activity Feed section', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('Activity Feed')).toBeInTheDocument()
    })
  })

  it('shows the empty state when no activity items are returned', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('No activity yet.')).toBeInTheDocument()
    })
  })

  it('renders the Refresh button', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })

  it('renders type and view filter dropdowns', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByDisplayValue('All types')).toBeInTheDocument()
      expect(screen.getByDisplayValue('All views')).toBeInTheDocument()
    })
  })

  it('shows "since you\'ve been away" badge when count > 0', async () => {
    const { activityApi } = await import('../../lib/api')
    vi.mocked(activityApi.countSince).mockResolvedValue(7)

    // Stub localStorage for this test
    const store: Record<string, string> = {
      'open-brain-last-visit': new Date(Date.now() - 3600000).toISOString(),
    }
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
    })

    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('7 new')).toBeInTheDocument()
    })

    vi.unstubAllGlobals()
    // Re-stub EventSource since unstubAllGlobals removes it
    vi.stubGlobal('EventSource', NoopEventSource)
  })

  it('renders activity items when feed has data', async () => {
    const { activityApi } = await import('../../lib/api')
    vi.mocked(activityApi.list).mockResolvedValue({
      items: [
        {
          id: 'a1',
          type: 'capture',
          subtype: 'created',
          timestamp: new Date().toISOString(),
          summary: 'New observation from voice: Testing the feed',
          view: 'technical',
          detail: null,
          source_id: 'c1',
          created_at: new Date().toISOString(),
        },
      ],
      total: 1,
      limit: 30,
      offset: 0,
    })

    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText(/Testing the feed/)).toBeInTheDocument()
    })
  })
})
