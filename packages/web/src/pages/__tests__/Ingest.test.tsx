import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock the API module before importing Ingest so all fetch calls are intercepted
vi.mock('../../lib/api', () => ({
  ingestApi: {
    list: vi.fn().mockResolvedValue({ uploads: [], total: 0, limit: 20, offset: 0 }),
    upload: vi.fn(),
    get: vi.fn(),
    process: vi.fn(),
    processNow: vi.fn(),
    subscribeToEvents: vi.fn().mockReturnValue(() => {}),
  },
}))

// Mock the SSE module — the FileDropZone / api layer may reach into it
vi.mock('../../lib/sse', () => ({
  sseClient: {
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
  },
  createSSEConnection: vi.fn().mockReturnValue(() => {}),
}))

class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
  onerror = null
  onmessage = null
}
vi.stubGlobal('EventSource', NoopEventSource)

import { Ingest } from '../Ingest'

function renderIngest() {
  return render(
    <MemoryRouter>
      <Ingest />
    </MemoryRouter>,
  )
}

describe('Ingest page', () => {
  it('renders without crashing and shows the empty state', async () => {
    renderIngest()
    expect(screen.getByRole('heading', { level: 1, name: /ingest/i })).toBeInTheDocument()
    expect(
      screen.getByText(/drop csvs, html exports, pdfs\./i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /process inbox now/i }),
    ).toBeInTheDocument()

    await waitFor(() => {
      expect(
        screen.getByText(/no uploads yet\. drop a file above to get started\./i),
      ).toBeInTheDocument()
    })
  })
})
