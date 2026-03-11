import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SkillHistoryCard from '../SkillHistoryCard'
import type { SkillHistoryCardProps } from '../SkillHistoryCard'
import type { IntelligenceEntry } from '@/lib/api'

// Stub EventSource so sse.ts module init doesn't throw
class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
  onerror = null
}
vi.stubGlobal('EventSource', NoopEventSource)

function makeEntry(overrides: Partial<IntelligenceEntry> = {}): IntelligenceEntry {
  return {
    id: 'log-1',
    skill_name: 'daily-connections',
    capture_id: 'cap-abc',
    input_summary: null,
    output_summary: 'Found 3 cross-domain patterns',
    result: {
      summary: 'Patterns detected',
      connections: [{ theme: 'AI + Ops', insight: 'Great insight', confidence: 'high' }],
    },
    duration_ms: 5200,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function defaultProps(overrides: Partial<SkillHistoryCardProps> = {}): SkillHistoryCardProps {
  return {
    title: 'Connections',
    description: 'Cross-domain patterns',
    icon: <span data-testid="icon">icon</span>,
    skillName: 'daily-connections',
    latestEntry: makeEntry(),
    fetchHistory: vi.fn().mockResolvedValue({ data: [] }),
    onTrigger: vi.fn().mockResolvedValue(undefined),
    triggering: false,
    ...overrides,
  }
}

describe('SkillHistoryCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---------- renders latest entry ----------

  it('renders title, description, and latest entry summary', () => {
    render(<SkillHistoryCard {...defaultProps()} />)

    expect(screen.getByText('Connections')).toBeInTheDocument()
    expect(screen.getByText('Cross-domain patterns')).toBeInTheDocument()
    expect(screen.getByText('Found 3 cross-domain patterns')).toBeInTheDocument()
  })

  it('renders duration badge for latest entry', () => {
    render(<SkillHistoryCard {...defaultProps()} />)

    // duration_ms 5200 → "5.2s"
    expect(screen.getByText('5.2s')).toBeInTheDocument()
  })

  it('renders "completed" when duration_ms is null', () => {
    const entry = makeEntry({ duration_ms: null })
    render(<SkillHistoryCard {...defaultProps({ latestEntry: entry })} />)

    expect(screen.getByText('completed')).toBeInTheDocument()
  })

  // ---------- empty state (no latestEntry) ----------

  it('shows empty state when latestEntry is null', () => {
    render(<SkillHistoryCard {...defaultProps({ latestEntry: null })} />)

    expect(screen.getByText('No analysis yet.')).toBeInTheDocument()
    expect(screen.getByText('Click "Run" to generate your first analysis.')).toBeInTheDocument()
  })

  // ---------- trigger button ----------

  it('renders Run button that calls onTrigger with skillName', async () => {
    const user = userEvent.setup()
    const onTrigger = vi.fn().mockResolvedValue(undefined)

    render(<SkillHistoryCard {...defaultProps({ onTrigger })} />)

    // The Run button text is exactly "Run" — use getAllByRole and pick the first
    // (the second button with "run" in name is "Show run history")
    const runButtons = screen.getAllByRole('button', { name: /run/i })
    const button = runButtons[0]
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('Run')

    await user.click(button)

    expect(onTrigger).toHaveBeenCalledOnce()
    expect(onTrigger).toHaveBeenCalledWith('daily-connections')
  })

  it('disables trigger button and shows "Queuing..." when triggering', () => {
    render(<SkillHistoryCard {...defaultProps({ triggering: true })} />)

    const button = screen.getByRole('button', { name: /queuing/i })
    expect(button).toBeDisabled()
  })

  // ---------- history panel ----------

  it('shows "Show run history" button', () => {
    render(<SkillHistoryCard {...defaultProps()} />)

    expect(screen.getByText('Show run history')).toBeInTheDocument()
  })

  it('expands history panel and fetches history on click', async () => {
    const user = userEvent.setup()
    const historyEntries = [
      makeEntry({ id: 'h1', output_summary: 'Run 1', duration_ms: 3000 }),
      makeEntry({ id: 'h2', output_summary: 'Run 2', duration_ms: 4500 }),
    ]
    const fetchHistory = vi.fn().mockResolvedValue({ data: historyEntries })

    render(<SkillHistoryCard {...defaultProps({ fetchHistory })} />)

    const toggle = screen.getByText('Show run history')
    await user.click(toggle)

    // fetchHistory should be called
    expect(fetchHistory).toHaveBeenCalledWith(20)

    // After loading, history entries should be visible
    await waitFor(() => {
      expect(screen.getByText('Hide history')).toBeInTheDocument()
    })
  })

  it('shows empty history message when no runs recorded', async () => {
    const user = userEvent.setup()
    const fetchHistory = vi.fn().mockResolvedValue({ data: [] })

    render(<SkillHistoryCard {...defaultProps({ fetchHistory })} />)

    await user.click(screen.getByText('Show run history'))

    await waitFor(() => {
      expect(screen.getByText('No runs recorded yet.')).toBeInTheDocument()
    })
  })

  it('shows error message when history fetch fails', async () => {
    const user = userEvent.setup()
    const fetchHistory = vi.fn().mockRejectedValue(new Error('Network error'))

    render(<SkillHistoryCard {...defaultProps({ fetchHistory })} />)

    await user.click(screen.getByText('Show run history'))

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument()
    })
  })

  // ---------- icon rendering ----------

  it('renders the icon prop', () => {
    render(<SkillHistoryCard {...defaultProps()} />)

    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })
})
