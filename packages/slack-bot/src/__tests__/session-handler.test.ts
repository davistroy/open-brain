/**
 * Tests for the governance session thread handler.
 *
 * Covers:
 * - Thread reply routing to sessions_respond
 * - Board role attribution in responses
 * - !board pause / !board done / !board abandon in-thread commands
 * - Redis mapping helpers (setSessionThread, getSessionThread, deleteSessionThread)
 * - Auto-cleanup when session auto-completes
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import {
  handleSessionThreadReply,
  setSessionThread,
  getSessionThread,
  deleteSessionThread,
} from '../handlers/session.js'
import type { CoreApiClient, SessionRecord } from '../lib/core-api-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSay(): SayFn {
  return vi.fn().mockResolvedValue({})
}

function makeThreadMessage(text: string, threadTs = '1111.0001', ts = '1111.0002'): GenericMessageEvent {
  return {
    type: 'message',
    subtype: undefined,
    channel: 'C1234567890',
    ts,
    thread_ts: threadTs,
    text,
    user: 'U111222333',
  } as unknown as GenericMessageEvent
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-abc-12345678',
    session_type: 'governance',
    status: 'active',
    config: null,
    summary: null,
    created_at: '2026-03-05T10:00:00Z',
    updated_at: '2026-03-05T10:00:00Z',
    completed_at: null,
    ...overrides,
  }
}

function makeRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  }
}

function makeClient(overrides: Partial<CoreApiClient> = {}): CoreApiClient {
  return {
    sessions_respond: vi.fn().mockResolvedValue({
      session: makeSession(),
      bot_message: 'Good. What decisions did you make this week?',
    }),
    sessions_pause: vi.fn().mockResolvedValue({ session: makeSession({ status: 'paused' }) }),
    sessions_complete: vi.fn().mockResolvedValue({
      session: makeSession({ status: 'complete' }),
      summary: 'Session summary: strong week, key decisions on pricing.',
    }),
    sessions_abandon: vi.fn().mockResolvedValue({ session: makeSession({ status: 'abandoned' }) }),
    ...overrides,
  } as unknown as CoreApiClient
}

const SESSION_ID = 'sess-abc-12345678'
const THREAD_TS = '1111.0001'

// ---------------------------------------------------------------------------
// Redis helper tests
// ---------------------------------------------------------------------------

describe('setSessionThread / getSessionThread / deleteSessionThread', () => {
  it('sets a session id keyed by thread_ts', async () => {
    const redis = makeRedis()
    await setSessionThread(redis as never, THREAD_TS, SESSION_ID)
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(THREAD_TS),
      SESSION_ID,
      'EX',
      expect.any(Number),
    )
  })

  it('gets session id for a thread_ts', async () => {
    const redis = makeRedis({ get: vi.fn().mockResolvedValue(SESSION_ID) })
    const result = await getSessionThread(redis as never, THREAD_TS)
    expect(result).toBe(SESSION_ID)
  })

  it('returns null when no mapping exists', async () => {
    const redis = makeRedis()
    const result = await getSessionThread(redis as never, THREAD_TS)
    expect(result).toBeNull()
  })

  it('deletes the mapping', async () => {
    const redis = makeRedis()
    await deleteSessionThread(redis as never, THREAD_TS)
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(THREAD_TS))
  })
})

// ---------------------------------------------------------------------------
// handleSessionThreadReply tests
// ---------------------------------------------------------------------------

describe('handleSessionThreadReply()', () => {
  let say: SayFn
  let client: CoreApiClient
  let redis: ReturnType<typeof makeRedis>

  beforeEach(() => {
    say = makeSay()
    client = makeClient()
    redis = makeRedis()
  })

  // -------------------------------------------------------------------------
  // Normal replies
  // -------------------------------------------------------------------------

  it('calls sessions_respond with the user message text', async () => {
    await handleSessionThreadReply(makeThreadMessage('My main blocker is budget approval'), say, client, redis as never, SESSION_ID)
    expect(client.sessions_respond).toHaveBeenCalledWith(SESSION_ID, 'My main blocker is budget approval')
  })

  it('replies with board role attribution', async () => {
    await handleSessionThreadReply(makeThreadMessage('We decided on tiered pricing'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain('Board:')
  })

  it('replies with bot_message content from sessions_respond', async () => {
    await handleSessionThreadReply(makeThreadMessage('Some reply'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain('Good. What decisions did you make this week?')
  })

  it('replies in thread (thread_ts = message ts)', async () => {
    const msg = makeThreadMessage('Some reply', THREAD_TS, '1111.0002')
    await handleSessionThreadReply(msg, say, client, redis as never, SESSION_ID)
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1111.0002' }))
  })

  it('handles sessions_respond error gracefully', async () => {
    ;(client.sessions_respond as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503'))
    await handleSessionThreadReply(makeThreadMessage('Some reply'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain(':warning:')
  })

  // -------------------------------------------------------------------------
  // Auto-complete cleanup
  // -------------------------------------------------------------------------

  it('cleans up Redis mapping when session auto-completes', async () => {
    ;(client.sessions_respond as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: makeSession({ status: 'complete', summary: 'Auto-complete summary.' }),
      bot_message: 'Session complete.',
    })
    await handleSessionThreadReply(makeThreadMessage('done'), say, client, redis as never, SESSION_ID)
    expect(redis.del).toHaveBeenCalled()
  })

  it('posts summary when session auto-completes with summary', async () => {
    ;(client.sessions_respond as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: makeSession({ status: 'complete', summary: 'Auto-complete summary.' }),
      bot_message: 'Session complete.',
    })
    await handleSessionThreadReply(makeThreadMessage('done'), say, client, redis as never, SESSION_ID)
    const calls = (say as ReturnType<typeof vi.fn>).mock.calls
    const summaryCall = calls.find((c) => (c[0] as { text: string }).text.includes('Session Complete'))
    expect(summaryCall).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // !board pause (in-thread command)
  // -------------------------------------------------------------------------

  it('!board pause — calls sessions_pause and cleans up Redis', async () => {
    await handleSessionThreadReply(makeThreadMessage('!board pause'), say, client, redis as never, SESSION_ID)
    expect(client.sessions_pause).toHaveBeenCalledWith(SESSION_ID)
    expect(redis.del).toHaveBeenCalled()
  })

  it('!board pause — replies with pause confirmation', async () => {
    await handleSessionThreadReply(makeThreadMessage('!board pause'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain('paused')
  })

  it('!board pause — handles sessions_pause failure gracefully', async () => {
    ;(client.sessions_pause as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404'))
    await handleSessionThreadReply(makeThreadMessage('!board pause'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain(':warning:')
  })

  // -------------------------------------------------------------------------
  // !board done (in-thread command)
  // -------------------------------------------------------------------------

  it('!board done — calls sessions_complete and cleans up Redis', async () => {
    await handleSessionThreadReply(makeThreadMessage('!board done'), say, client, redis as never, SESSION_ID)
    expect(client.sessions_complete).toHaveBeenCalledWith(SESSION_ID)
    expect(redis.del).toHaveBeenCalled()
  })

  it('!board done — posts summary from sessions_complete', async () => {
    await handleSessionThreadReply(makeThreadMessage('!board done'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain('Session Complete')
    expect(call.text).toContain('strong week')
  })

  it('!board done — handles sessions_complete failure gracefully', async () => {
    ;(client.sessions_complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
    await handleSessionThreadReply(makeThreadMessage('!board done'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain(':warning:')
  })

  // -------------------------------------------------------------------------
  // !board abandon (in-thread command)
  // -------------------------------------------------------------------------

  it('!board abandon — calls sessions_abandon and cleans up Redis', async () => {
    await handleSessionThreadReply(makeThreadMessage('!board abandon'), say, client, redis as never, SESSION_ID)
    expect(client.sessions_abandon).toHaveBeenCalledWith(SESSION_ID)
    expect(redis.del).toHaveBeenCalled()
  })

  it('!board abandon — replies with abandon confirmation', async () => {
    await handleSessionThreadReply(makeThreadMessage('!board abandon'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain('abandoned')
  })

  it('!board abandon — handles sessions_abandon failure gracefully', async () => {
    ;(client.sessions_abandon as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
    await handleSessionThreadReply(makeThreadMessage('!board abandon'), say, client, redis as never, SESSION_ID)
    const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
    expect(call.text).toContain(':warning:')
  })

  // -------------------------------------------------------------------------
  // Empty message guard
  // -------------------------------------------------------------------------

  it('skips messages with empty text', async () => {
    const msg = makeThreadMessage('')
    await handleSessionThreadReply(msg, say, client, redis as never, SESSION_ID)
    expect(client.sessions_respond).not.toHaveBeenCalled()
  })
})
