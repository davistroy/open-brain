import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { EmailDraftsList } from '../EmailDraftsList'
import type { EmailDraft } from '@/lib/types'

vi.mock('@/lib/api', () => ({
  emailApi: {
    list: vi.fn(),
  },
}))

import { emailApi } from '@/lib/api'

function makeDraft(overrides: Partial<EmailDraft> = {}): EmailDraft {
  return {
    id: 'draft-1',
    to_address: 'alice@example.com',
    cc_address: null,
    subject: 'Test subject',
    body: 'Test body',
    status: 'draft',
    send_mode: 'review-required',
    source: 'web-compose',
    approved_at: null,
    sent_at: null,
    himalaya_message_id: null,
    capture_id: null,
    metadata: null,
    created_at: '2026-04-17T12:00:00Z',
    updated_at: '2026-04-17T12:00:00Z',
    ...overrides,
  }
}

describe('EmailDraftsList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders empty state when emailApi.list returns no drafts', async () => {
    ;(emailApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    })

    render(<EmailDraftsList onOpenDraft={vi.fn()} />)

    await waitFor(() => {
      expect(
        screen.getByText(/No drafts yet\. Click Compose to start one\./i),
      ).toBeInTheDocument()
    })

    expect(emailApi.list).toHaveBeenCalledWith({ status: 'draft', limit: 50 })
  })

  it('renders drafts and fires onOpenDraft on click', async () => {
    ;(emailApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [makeDraft({ id: 'd-42', subject: 'Hello world' })],
      total: 1,
      limit: 50,
      offset: 0,
    })

    const onOpenDraft = vi.fn()
    render(<EmailDraftsList onOpenDraft={onOpenDraft} statusFilter="all" />)

    await waitFor(() => {
      expect(screen.getByText('Hello world')).toBeInTheDocument()
    })

    // statusFilter 'all' should omit the status param
    expect(emailApi.list).toHaveBeenCalledWith({ status: undefined, limit: 50 })

    fireEvent.click(screen.getByText('Hello world'))
    expect(onOpenDraft).toHaveBeenCalledWith('d-42')
  })
})
