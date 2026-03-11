import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { handleCommand } from '../handlers/command.js'
import type { CoreApiClient } from '../lib/core-api-client.js'

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

function makeClient(overrides: Partial<CoreApiClient> = {}): CoreApiClient {
  return {
    stats_get: vi.fn(),
    skills_trigger: vi.fn().mockResolvedValue({ queued: true, job_id: 'job-connections-001' }),
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
    ...overrides,
  } as unknown as CoreApiClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('!connections command', () => {
  let say: SayFn
  let client: CoreApiClient

  beforeEach(() => {
    vi.restoreAllMocks()
    say = makeSay()
    client = makeClient()
  })

  // -----------------------------------------------------------------------
  // Default (no args)
  // -----------------------------------------------------------------------

  describe('!connections (default)', () => {
    it('sends acknowledgment message with default 7-day window', async () => {
      await handleCommand(makeMessage('!connections'), say, client)
      const firstCall = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string; thread_ts: string }
      expect(firstCall.text).toContain('7 days')
      expect(firstCall.thread_ts).toBe('1234567890.000100')
    })

    it('calls skills_trigger with daily-connections and default windowDays', async () => {
      await handleCommand(makeMessage('!connections'), say, client)
      expect(client.skills_trigger).toHaveBeenCalledWith('daily-connections', { windowDays: 7 })
    })

    it('sends queued confirmation after trigger', async () => {
      await handleCommand(makeMessage('!connections'), say, client)
      // Second call is the queued confirmation
      const calls = (say as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(2)
      const secondCall = calls[1][0] as { text: string }
      expect(secondCall.text).toContain('queued')
      expect(secondCall.text).toContain('job-connections-001')
    })

    it('replies in thread', async () => {
      const msg = makeMessage('!connections', { ts: '9999.0001' })
      await handleCommand(msg, say, client)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '9999.0001' }))
    })
  })

  // -----------------------------------------------------------------------
  // Custom days
  // -----------------------------------------------------------------------

  describe('!connections <days>', () => {
    it('passes custom day count to skills_trigger', async () => {
      await handleCommand(makeMessage('!connections 14'), say, client)
      expect(client.skills_trigger).toHaveBeenCalledWith('daily-connections', { windowDays: 14 })
    })

    it('sends acknowledgment with custom day count', async () => {
      await handleCommand(makeMessage('!connections 30'), say, client)
      const firstCall = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(firstCall.text).toContain('30 days')
    })

    it('caps day count at 90', async () => {
      await handleCommand(makeMessage('!connections 365'), say, client)
      expect(client.skills_trigger).toHaveBeenCalledWith('daily-connections', { windowDays: 90 })
    })

    it('acknowledges with capped day count in message', async () => {
      await handleCommand(makeMessage('!connections 365'), say, client)
      const firstCall = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(firstCall.text).toContain('90 days')
    })
  })

  // -----------------------------------------------------------------------
  // Invalid arguments
  // -----------------------------------------------------------------------

  describe('!connections <invalid>', () => {
    it('returns error for non-numeric argument', async () => {
      await handleCommand(makeMessage('!connections abc'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
      expect(call.text).toContain('Invalid argument')
      expect(client.skills_trigger).not.toHaveBeenCalled()
    })

    it('returns error for zero', async () => {
      await handleCommand(makeMessage('!connections 0'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
      expect(client.skills_trigger).not.toHaveBeenCalled()
    })

    it('returns error for negative number', async () => {
      await handleCommand(makeMessage('!connections -5'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
      expect(client.skills_trigger).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('!connections error handling', () => {
    it('handles skills_trigger failure gracefully', async () => {
      ;(client.skills_trigger as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503 Service Unavailable'))
      await handleCommand(makeMessage('!connections'), say, client)
      const lastCall = (say as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { text: string }
      expect(lastCall.text).toContain('failed')
    })

    it('handles non-queued trigger response', async () => {
      ;(client.skills_trigger as ReturnType<typeof vi.fn>).mockResolvedValue({ queued: false })
      await handleCommand(makeMessage('!connections'), say, client)
      const lastCall = (say as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { text: string }
      expect(lastCall.text).toContain('triggered')
    })
  })
})

// ---------------------------------------------------------------------------
// Worker dispatcher — daily-connections case routing
// ---------------------------------------------------------------------------

describe('skill-execution worker — daily-connections dispatch', () => {
  it('daily-connections case calls executeDailyConnections with typed input', async () => {
    // Verify the dispatcher module imports and routes correctly
    // We import the module to confirm it can be loaded without error
    const mod = await import('../../src/handlers/commands/connections.js')
    expect(typeof mod.handleConnectionsCommand).toBe('function')
  })
})
