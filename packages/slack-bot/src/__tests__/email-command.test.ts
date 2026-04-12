import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { handleCommand } from '../handlers/command.js'
import type { CoreApiClient, EmailDraftRecord, EmailDraftListResult } from '../lib/core-api-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSay(): SayFn {
  return vi.fn().mockResolvedValue({})
}

function makeMessage(text: string, overrides: Partial<Record<string, unknown>> = {}): GenericMessageEvent {
  return {
    type: 'message',
    subtype: undefined,
    channel: 'C1234567890',
    ts: '1234567890.000100',
    text,
    user: 'U111222333',
    ...overrides,
  } as unknown as GenericMessageEvent
}

function makeDraft(overrides: Partial<EmailDraftRecord> = {}): EmailDraftRecord {
  return {
    id: 'draft-abc-12345678',
    to_address: 'alice@example.com',
    cc_address: null,
    subject: 'Project update',
    body: 'Hello Alice, here is the update.',
    status: 'draft',
    send_mode: 'review-required',
    source: 'slack',
    approved_at: null,
    sent_at: null,
    himalaya_message_id: null,
    capture_id: null,
    metadata: null,
    created_at: '2026-04-10T10:00:00Z',
    updated_at: '2026-04-10T10:00:00Z',
    ...overrides,
  }
}

function makeClient(overrides: Partial<CoreApiClient> = {}): CoreApiClient {
  return {
    stats_get: vi.fn(),
    skills_trigger: vi.fn(),
    skills_last_run: vi.fn(),
    captures_list: vi.fn(),
    captures_get: vi.fn(),
    captures_create: vi.fn(),
    captures_retry: vi.fn(),
    search_query: vi.fn(),
    synthesize_query: vi.fn(),
    entities_list: vi.fn(),
    entities_search: vi.fn(),
    entities_merge: vi.fn(),
    entities_split: vi.fn(),
    pipeline_health: vi.fn(),
    triggers_create: vi.fn(),
    triggers_list: vi.fn(),
    triggers_delete: vi.fn(),
    triggers_test: vi.fn(),
    sessions_create: vi.fn(),
    sessions_list: vi.fn(),
    sessions_respond: vi.fn(),
    sessions_pause: vi.fn(),
    sessions_resume: vi.fn(),
    sessions_complete: vi.fn(),
    sessions_abandon: vi.fn(),
    bets_list: vi.fn(),
    bets_create: vi.fn(),
    bets_expiring: vi.fn(),
    bets_resolve: vi.fn(),
    email_drafts_create: vi.fn(),
    email_drafts_list: vi.fn(),
    email_drafts_get: vi.fn(),
    email_drafts_send: vi.fn(),
    email_drafts_reject: vi.fn(),
    ...overrides,
  } as unknown as CoreApiClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('!email command', () => {
  let say: SayFn
  let client: CoreApiClient

  beforeEach(() => {
    vi.restoreAllMocks()
    say = makeSay()
    client = makeClient()
  })

  // -----------------------------------------------------------------------
  // !email (no subcommand) — shows help
  // -----------------------------------------------------------------------

  describe('!email (no subcommand)', () => {
    it('shows email command help text', async () => {
      await handleCommand(makeMessage('!email'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string; thread_ts: string }
      expect(call.text).toContain('Email Commands')
      expect(call.text).toContain('!email send')
      expect(call.text).toContain('!email drafts')
      expect(call.text).toContain('!email approve')
      expect(call.text).toContain('!email reject')
      expect(call.thread_ts).toBe('1234567890.000100')
    })
  })

  // -----------------------------------------------------------------------
  // !email send
  // -----------------------------------------------------------------------

  describe('!email send', () => {
    it('creates a draft and shows confirmation', async () => {
      const draft = makeDraft()
      ;(client.email_drafts_create as ReturnType<typeof vi.fn>).mockResolvedValue(draft)

      await handleCommand(makeMessage('!email send alice@example.com Project update'), say, client)

      expect(client.email_drafts_create).toHaveBeenCalledWith(expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Project update',
        source: 'slack',
      }))

      // Second say call is the confirmation (first is the "Creating..." message)
      const calls = (say as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(2)
      const confirmCall = calls[1][0] as { text: string }
      expect(confirmCall.text).toContain('Email draft created')
      expect(confirmCall.text).toContain('alice@example.com')
      expect(confirmCall.text).toContain('Project update')
      expect(confirmCall.text).toContain(draft.id)
    })

    it('sends "Creating..." progress message', async () => {
      const draft = makeDraft()
      ;(client.email_drafts_create as ReturnType<typeof vi.fn>).mockResolvedValue(draft)

      await handleCommand(makeMessage('!email send alice@example.com Hello world'), say, client)

      const firstCall = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(firstCall.text).toContain('Creating email draft')
    })

    it('rejects missing email address', async () => {
      await handleCommand(makeMessage('!email send'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
      expect(call.text).toContain('!email send')
      expect(client.email_drafts_create).not.toHaveBeenCalled()
    })

    it('rejects invalid email (no @)', async () => {
      await handleCommand(makeMessage('!email send notanemail Subject here'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
      expect(client.email_drafts_create).not.toHaveBeenCalled()
    })

    it('rejects missing subject', async () => {
      await handleCommand(makeMessage('!email send alice@example.com'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Missing subject')
      expect(client.email_drafts_create).not.toHaveBeenCalled()
    })

    it('handles API error gracefully', async () => {
      ;(client.email_drafts_create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 500: Internal server error'))

      await handleCommand(makeMessage('!email send alice@example.com Test subject'), say, client)

      const lastCall = (say as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { text: string }
      expect(lastCall.text).toContain('Failed to create email draft')
    })

    it('replies in the correct thread', async () => {
      const draft = makeDraft()
      ;(client.email_drafts_create as ReturnType<typeof vi.fn>).mockResolvedValue(draft)

      const msg = makeMessage('!email send alice@example.com Test', { ts: '9999.0001' })
      await handleCommand(msg, say, client)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '9999.0001' }))
    })

    it('handles multi-word subject', async () => {
      const draft = makeDraft({ subject: 'Q2 Planning Meeting Notes for Review' })
      ;(client.email_drafts_create as ReturnType<typeof vi.fn>).mockResolvedValue(draft)

      await handleCommand(makeMessage('!email send bob@corp.com Q2 Planning Meeting Notes for Review'), say, client)

      expect(client.email_drafts_create).toHaveBeenCalledWith(expect.objectContaining({
        to: 'bob@corp.com',
        subject: 'Q2 Planning Meeting Notes for Review',
      }))
    })
  })

  // -----------------------------------------------------------------------
  // !email drafts
  // -----------------------------------------------------------------------

  describe('!email drafts', () => {
    it('lists pending drafts', async () => {
      const listResult: EmailDraftListResult = {
        items: [
          makeDraft({ id: 'draft-001', subject: 'First email', to_address: 'a@example.com' }),
          makeDraft({ id: 'draft-002', subject: 'Second email', to_address: 'b@example.com' }),
        ],
        total: 2,
        limit: 20,
        offset: 0,
      }
      ;(client.email_drafts_list as ReturnType<typeof vi.fn>).mockResolvedValue(listResult)

      await handleCommand(makeMessage('!email drafts'), say, client)

      expect(client.email_drafts_list).toHaveBeenCalledWith('draft')

      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Pending Email Drafts')
      expect(call.text).toContain('First email')
      expect(call.text).toContain('Second email')
      expect(call.text).toContain('a@example.com')
      expect(call.text).toContain('b@example.com')
    })

    it('shows empty state when no drafts', async () => {
      const listResult: EmailDraftListResult = {
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      }
      ;(client.email_drafts_list as ReturnType<typeof vi.fn>).mockResolvedValue(listResult)

      await handleCommand(makeMessage('!email drafts'), say, client)

      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No pending email drafts')
    })

    it('shows overflow message when more than 10 drafts', async () => {
      const items = Array.from({ length: 12 }, (_, i) =>
        makeDraft({ id: `draft-${i}`, subject: `Email ${i}`, to_address: `user${i}@example.com` })
      )
      const listResult: EmailDraftListResult = {
        items,
        total: 12,
        limit: 20,
        offset: 0,
      }
      ;(client.email_drafts_list as ReturnType<typeof vi.fn>).mockResolvedValue(listResult)

      await handleCommand(makeMessage('!email drafts'), say, client)

      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('2 more')
    })

    it('handles API error gracefully', async () => {
      ;(client.email_drafts_list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 500'))

      await handleCommand(makeMessage('!email drafts'), say, client)

      const call = (say as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { text: string }
      expect(call.text).toContain('Failed to list email drafts')
    })

    it('replies in thread', async () => {
      const listResult: EmailDraftListResult = { items: [], total: 0, limit: 20, offset: 0 }
      ;(client.email_drafts_list as ReturnType<typeof vi.fn>).mockResolvedValue(listResult)

      const msg = makeMessage('!email drafts', { ts: '9999.0001' })
      await handleCommand(msg, say, client)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '9999.0001' }))
    })
  })

  // -----------------------------------------------------------------------
  // !email approve
  // -----------------------------------------------------------------------

  describe('!email approve', () => {
    it('approves and sends a draft', async () => {
      const sentDraft = makeDraft({ id: 'draft-abc-12345678', status: 'sent' })
      ;(client.email_drafts_send as ReturnType<typeof vi.fn>).mockResolvedValue(sentDraft)

      await handleCommand(makeMessage('!email approve draft-abc-12345678'), say, client)

      expect(client.email_drafts_send).toHaveBeenCalledWith('draft-abc-12345678')

      // Second call is the confirmation (first is the "Approving..." message)
      const calls = (say as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(2)
      const confirmCall = calls[1][0] as { text: string }
      expect(confirmCall.text).toContain('Email sent')
      expect(confirmCall.text).toContain('sent')
    })

    it('sends progress message before approval', async () => {
      const sentDraft = makeDraft({ status: 'sent' })
      ;(client.email_drafts_send as ReturnType<typeof vi.fn>).mockResolvedValue(sentDraft)

      await handleCommand(makeMessage('!email approve draft-abc-12345678'), say, client)

      const firstCall = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(firstCall.text).toContain('Approving')
    })

    it('rejects missing draft ID', async () => {
      await handleCommand(makeMessage('!email approve'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
      expect(call.text).toContain('!email approve')
      expect(client.email_drafts_send).not.toHaveBeenCalled()
    })

    it('handles API error gracefully', async () => {
      ;(client.email_drafts_send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 404: Not found'))

      await handleCommand(makeMessage('!email approve bad-id'), say, client)

      const lastCall = (say as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { text: string }
      expect(lastCall.text).toContain('Failed to approve')
    })

    it('replies in thread', async () => {
      const sentDraft = makeDraft({ status: 'sent' })
      ;(client.email_drafts_send as ReturnType<typeof vi.fn>).mockResolvedValue(sentDraft)

      const msg = makeMessage('!email approve draft-123', { ts: '9999.0001' })
      await handleCommand(msg, say, client)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '9999.0001' }))
    })
  })

  // -----------------------------------------------------------------------
  // !email reject
  // -----------------------------------------------------------------------

  describe('!email reject', () => {
    it('rejects a draft', async () => {
      const rejectedDraft = makeDraft({ id: 'draft-abc-12345678', status: 'rejected' })
      ;(client.email_drafts_reject as ReturnType<typeof vi.fn>).mockResolvedValue(rejectedDraft)

      await handleCommand(makeMessage('!email reject draft-abc-12345678'), say, client)

      expect(client.email_drafts_reject).toHaveBeenCalledWith('draft-abc-12345678')

      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('rejected')
    })

    it('rejects missing draft ID', async () => {
      await handleCommand(makeMessage('!email reject'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
      expect(call.text).toContain('!email reject')
      expect(client.email_drafts_reject).not.toHaveBeenCalled()
    })

    it('handles API error gracefully', async () => {
      ;(client.email_drafts_reject as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 404: Not found'))

      await handleCommand(makeMessage('!email reject bad-id'), say, client)

      const lastCall = (say as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { text: string }
      expect(lastCall.text).toContain('Failed to reject')
    })

    it('replies in thread', async () => {
      const rejectedDraft = makeDraft({ status: 'rejected' })
      ;(client.email_drafts_reject as ReturnType<typeof vi.fn>).mockResolvedValue(rejectedDraft)

      const msg = makeMessage('!email reject draft-123', { ts: '9999.0001' })
      await handleCommand(msg, say, client)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '9999.0001' }))
    })
  })

  // -----------------------------------------------------------------------
  // Unknown subcommand
  // -----------------------------------------------------------------------

  describe('!email <unknown>', () => {
    it('shows email command help for unknown subcommand', async () => {
      await handleCommand(makeMessage('!email foo'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Email Commands')
      expect(call.text).toContain('!email send')
    })
  })
})

// ---------------------------------------------------------------------------
// Module export verification
// ---------------------------------------------------------------------------

describe('email command — module export', () => {
  it('handleEmailCommand is exported as a function', async () => {
    const mod = await import('../../src/handlers/commands/email.js')
    expect(typeof mod.handleEmailCommand).toBe('function')
  })
})
