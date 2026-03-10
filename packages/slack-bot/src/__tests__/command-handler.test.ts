import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { handleCommand } from '../handlers/command.js'
import type { CoreApiClient, BrainStats, TriggerRecord, TriggerMatch, EntityMergeResult, EntitySplitResult, SessionRecord, BetRecord } from '../lib/core-api-client.js'

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

function makeStats(): BrainStats {
  return {
    total_captures: 42,
    by_source: { slack: 30, voice: 10, api: 2 },
    by_type: { decision: 10, idea: 15, observation: 17 },
    by_view: { work: 20, personal: 12, technical: 10 },
    pipeline_health: { pending: 1, processing: 0, complete: 40, failed: 1 },
  }
}

function makeCapture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-abc-123',
    content: 'Decided to use tiered pricing for the QSR segment.',
    capture_type: 'decision',
    brain_view: 'work-internal',
    source: 'slack',
    pipeline_status: 'complete',
    tags: [],
    created_at: '2026-03-05T10:00:00Z',
    pre_extracted: { topics: ['pricing', 'QSR'], entities: [], sentiment: 'positive' },
    ...overrides,
  }
}

function makeTrigger(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    id: 'trig-001',
    name: 'QSR timeline',
    query_text: 'QSR timeline',
    threshold: 0.72,
    cooldown_minutes: 60,
    delivery_channel: 'pushover',
    is_active: true,
    fire_count: 3,
    last_fired_at: '2026-03-04T10:00:00Z',
    created_at: '2026-03-01T00:00:00Z',
    ...overrides,
  }
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

function makeBet(overrides: Partial<BetRecord> = {}): BetRecord {
  return {
    id: 'bet-xyz-12345678',
    statement: 'QSR deal closes by Q2 2026',
    confidence: 0.75,
    domain: 'business',
    resolution_date: '2026-06-30T00:00:00Z',
    resolution: null,
    resolution_notes: null,
    session_id: null,
    created_at: '2026-03-05T10:00:00Z',
    updated_at: '2026-03-05T10:00:00Z',
    ...overrides,
  }
}

// Minimal Redis mock (only the methods session handler uses)
function makeRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  }
}

function makeClient(overrides: Partial<CoreApiClient> = {}): CoreApiClient {
  return {
    stats_get: vi.fn().mockResolvedValue(makeStats()),
    skills_trigger: vi.fn().mockResolvedValue({ queued: true, job_id: 'job-001' }),
    skills_last_run: vi.fn().mockResolvedValue({
      skill_name: 'weekly-brief',
      status: 'success',
      completed_at: '2026-03-03T08:00:00Z',
      duration_ms: 12_000,
      captures_queried: 48,
      result_summary: 'Strong week in QSR work.',
    }),
    captures_list: vi.fn().mockResolvedValue({ captures: [makeCapture()], total: 1 }),
    captures_get: vi.fn(),
    captures_create: vi.fn(),
    captures_retry: vi.fn().mockResolvedValue(undefined),
    search_query: vi.fn(),
    synthesize_query: vi.fn(),
    entities_list: vi.fn().mockResolvedValue({
      entities: [
        { id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: ['QSR'], capture_count: 12, last_seen_at: '2026-03-05T10:00:00Z' },
        { id: 'ent-002', name: 'Alice Smith', type: 'person', aliases: [], capture_count: 5 },
      ],
      total: 2,
    }),
    entities_search: vi.fn().mockResolvedValue({
      entities: [
        { id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: ['QSR'], capture_count: 12, last_seen_at: '2026-03-05T10:00:00Z' },
      ],
      total: 1,
    }),
    entities_merge: vi.fn().mockResolvedValue({
      message: 'Entity ent-001 merged into ent-002',
      source_id: 'ent-001',
      target_id: 'ent-002',
    } as EntityMergeResult),
    entities_split: vi.fn().mockResolvedValue({
      message: 'Alias "QSR" split into new entity',
      source_entity_id: 'ent-001',
      new_entity_id: 'ent-new-001',
      alias: 'QSR',
    } as EntitySplitResult),
    pipeline_health: vi.fn().mockResolvedValue({
      queues: {
        'ingest': { waiting: 2, active: 1, completed: 100, failed: 0, delayed: 0 },
        'embed': { waiting: 0, active: 0, completed: 98, failed: 2, delayed: 0 },
      },
      overall: { pending: 2, processing: 1, complete: 100, failed: 2 },
    }),
    triggers_create: vi.fn().mockResolvedValue(makeTrigger()),
    triggers_list: vi.fn().mockResolvedValue({ triggers: [makeTrigger()] }),
    triggers_delete: vi.fn().mockResolvedValue(undefined),
    triggers_test: vi.fn().mockResolvedValue({
      query_text: 'QSR timeline',
      matches: [
        { id: 'cap-001', content: 'QSR deal timeline updated.', capture_type: 'decision', brain_view: 'work', created_at: '2026-03-04T10:00:00Z', similarity: 0.87 } as TriggerMatch,
      ],
    }),
    sessions_create: vi.fn().mockResolvedValue({
      session: makeSession(),
      first_message: 'Let\'s begin the quick board check. What are you working on right now?',
    }),
    sessions_list: vi.fn().mockResolvedValue({ items: [makeSession()], total: 1, limit: 10, offset: 0 }),
    sessions_respond: vi.fn().mockResolvedValue({
      session: makeSession(),
      bot_message: 'Good. What decisions did you make this week?',
    }),
    sessions_pause: vi.fn().mockResolvedValue({ session: makeSession({ status: 'paused' }) }),
    sessions_resume: vi.fn().mockResolvedValue({
      session: makeSession({ status: 'active' }),
      context_message: 'Welcome back. We were discussing priorities.',
    }),
    sessions_complete: vi.fn().mockResolvedValue({
      session: makeSession({ status: 'complete' }),
      summary: 'Session summary: strong week, key decisions on pricing.',
    }),
    sessions_abandon: vi.fn().mockResolvedValue({ session: makeSession({ status: 'abandoned' }) }),
    bets_list: vi.fn().mockResolvedValue({ items: [makeBet()], total: 1, limit: 10, offset: 0 }),
    bets_create: vi.fn().mockResolvedValue(makeBet()),
    bets_expiring: vi.fn().mockResolvedValue({ items: [makeBet()], days_ahead: 7 }),
    bets_resolve: vi.fn().mockResolvedValue(makeBet({ resolution: 'correct', resolution_notes: 'Confirmed in Q2 report' })),
    ...overrides,
  } as unknown as CoreApiClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleCommand()', () => {
  let say: SayFn
  let client: CoreApiClient

  beforeEach(() => {
    say = makeSay()
    client = makeClient()
  })

  // -------------------------------------------------------------------------
  // Guard conditions
  // -------------------------------------------------------------------------

  it('skips messages with empty text', async () => {
    await handleCommand(makeMessage(''), say, client)
    expect(say).not.toHaveBeenCalled()
  })

  it('skips messages without ! prefix', async () => {
    await handleCommand(makeMessage('stats'), say, client)
    expect(say).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // !stats
  // -------------------------------------------------------------------------

  describe('!stats', () => {
    it('calls stats_get and replies with formatted stats', async () => {
      await handleCommand(makeMessage('!stats'), say, client)
      expect(client.stats_get).toHaveBeenCalled()
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Brain Stats')
      expect(call.text).toContain('42 total')
    })

    it('replies in thread', async () => {
      const msg = makeMessage('!stats', { ts: '9999.0001' })
      await handleCommand(msg, say, client)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '9999.0001' }))
    })

    it('handles stats_get failure gracefully', async () => {
      ;(client.stats_get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('503 unavailable'))
      await handleCommand(makeMessage('!stats'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
      expect(call.text).toContain('Stats unavailable')
    })
  })

  // -------------------------------------------------------------------------
  // !brief
  // -------------------------------------------------------------------------

  describe('!brief', () => {
    it('sends generating acknowledgment first', async () => {
      await handleCommand(makeMessage('!brief'), say, client)
      const firstCall = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(firstCall.text).toContain('Generating weekly brief')
    })

    it('calls skills_trigger with weekly-brief', async () => {
      await handleCommand(makeMessage('!brief'), say, client)
      expect(client.skills_trigger).toHaveBeenCalledWith('weekly-brief')
    })

    it('sends queued confirmation after trigger', async () => {
      await handleCommand(makeMessage('!brief'), say, client)
      const secondCall = (say as ReturnType<typeof vi.fn>).mock.calls[1][0] as { text: string }
      expect(secondCall.text).toContain('queued')
    })

    it('handles trigger failure gracefully', async () => {
      ;(client.skills_trigger as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!brief'), say, client)
      const lastCall = (say as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { text: string }
      expect(lastCall.text).toContain(':warning:')
    })
  })

  describe('!brief last', () => {
    it('calls skills_last_run with weekly-brief', async () => {
      await handleCommand(makeMessage('!brief last'), say, client)
      expect(client.skills_last_run).toHaveBeenCalledWith('weekly-brief')
    })

    it('shows last run details in reply', async () => {
      await handleCommand(makeMessage('!brief last'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Last Weekly Brief')
    })

    it('replies "no brief yet" when null returned', async () => {
      ;(client.skills_last_run as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      await handleCommand(makeMessage('!brief last'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No weekly brief')
    })
  })

  // -------------------------------------------------------------------------
  // !recent
  // -------------------------------------------------------------------------

  describe('!recent', () => {
    it('calls captures_list with default limit 5', async () => {
      await handleCommand(makeMessage('!recent'), say, client)
      expect(client.captures_list).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }))
    })

    it('parses custom limit from !recent 10', async () => {
      await handleCommand(makeMessage('!recent 10'), say, client)
      expect(client.captures_list).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }))
    })

    it('clamps limit to 20', async () => {
      await handleCommand(makeMessage('!recent 50'), say, client)
      expect(client.captures_list).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }))
    })

    it('shows capture content in reply', async () => {
      await handleCommand(makeMessage('!recent'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('tiered pricing')
    })

    it('handles captures_list failure gracefully', async () => {
      ;(client.captures_list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!recent'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !entities
  // -------------------------------------------------------------------------

  describe('!entities', () => {
    it('calls entities_list', async () => {
      await handleCommand(makeMessage('!entities'), say, client)
      expect(client.entities_list).toHaveBeenCalled()
    })

    it('shows entity names in reply', async () => {
      await handleCommand(makeMessage('!entities'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('QSR Corp')
      expect(call.text).toContain('Alice Smith')
    })

    it('handles entities_list failure gracefully', async () => {
      ;(client.entities_list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!entities'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !entity <name>
  // -------------------------------------------------------------------------

  describe('!entity', () => {
    it('calls entities_search with provided name', async () => {
      await handleCommand(makeMessage('!entity QSR Corp'), say, client)
      expect(client.entities_search).toHaveBeenCalledWith('QSR Corp')
    })

    it('shows entity detail in reply', async () => {
      await handleCommand(makeMessage('!entity QSR Corp'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('QSR Corp')
    })

    it('warns when no name provided', async () => {
      await handleCommand(makeMessage('!entity'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('replies "no entity found" when search returns empty', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>).mockResolvedValue({ entities: [], total: 0 })
      await handleCommand(makeMessage('!entity Nonexistent'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No entity found')
    })
  })

  // -------------------------------------------------------------------------
  // !entity merge
  // -------------------------------------------------------------------------

  describe('!entity merge', () => {
    it('resolves both names and calls entities_merge', async () => {
      // entities_search returns ent-001 for first call, ent-002 for second
      ;(client.entities_search as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ entities: [{ id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: ['QSR'], capture_count: 12 }], total: 1 })
        .mockResolvedValueOnce({ entities: [{ id: 'ent-002', name: 'QSR Corporation', type: 'organization', aliases: [], capture_count: 3 }], total: 1 })
      await handleCommand(makeMessage('!entity merge QSR Corp, QSR Corporation'), say, client)
      expect(client.entities_search).toHaveBeenCalledTimes(2)
      expect(client.entities_merge).toHaveBeenCalledWith('ent-001', 'ent-002')
    })

    it('confirms merge in reply', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ entities: [{ id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: [], capture_count: 5 }], total: 1 })
        .mockResolvedValueOnce({ entities: [{ id: 'ent-002', name: 'QSR Corporation', type: 'organization', aliases: [], capture_count: 3 }], total: 1 })
      await handleCommand(makeMessage('!entity merge QSR Corp, QSR Corporation'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Merge Complete')
      expect(call.text).toContain('ent-001')
      expect(call.text).toContain('ent-002')
    })

    it('warns when first entity name not found', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>).mockResolvedValue({ entities: [], total: 0 })
      await handleCommand(makeMessage('!entity merge Unknown, Other'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No entity found')
    })

    it('warns when second entity name not found', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ entities: [{ id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: [], capture_count: 5 }], total: 1 })
        .mockResolvedValueOnce({ entities: [], total: 0 })
      await handleCommand(makeMessage('!entity merge QSR Corp, Unknown'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No entity found')
    })

    it('warns when both names resolve to the same entity', async () => {
      const sameEntity = { id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: [], capture_count: 5 }
      ;(client.entities_search as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ entities: [sameEntity], total: 1 })
      await handleCommand(makeMessage('!entity merge QSR Corp, QSR Corp'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('same entity')
    })

    it('warns when no args provided', async () => {
      await handleCommand(makeMessage('!entity merge'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('handles entities_merge failure gracefully', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ entities: [{ id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: [], capture_count: 5 }], total: 1 })
        .mockResolvedValueOnce({ entities: [{ id: 'ent-002', name: 'Other', type: 'organization', aliases: [], capture_count: 1 }], total: 1 })
      ;(client.entities_merge as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!entity merge QSR Corp, Other'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !entity split
  // -------------------------------------------------------------------------

  describe('!entity split', () => {
    it('resolves entity name and calls entities_split with alias', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>).mockResolvedValue({
        entities: [{ id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: ['QSR'], capture_count: 12 }],
        total: 1,
      })
      await handleCommand(makeMessage('!entity split QSR Corp QSR'), say, client)
      expect(client.entities_search).toHaveBeenCalledWith('QSR Corp')
      expect(client.entities_split).toHaveBeenCalledWith('ent-001', 'QSR')
    })

    it('confirms split in reply', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>).mockResolvedValue({
        entities: [{ id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: ['QSR'], capture_count: 12 }],
        total: 1,
      })
      await handleCommand(makeMessage('!entity split QSR Corp QSR'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Split Complete')
      expect(call.text).toContain('ent-new-001')
    })

    it('warns when no args provided', async () => {
      await handleCommand(makeMessage('!entity split'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('warns when entity name not found', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>).mockResolvedValue({ entities: [], total: 0 })
      await handleCommand(makeMessage('!entity split Unknown Alias'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No entity found')
    })

    it('handles entities_split failure gracefully', async () => {
      ;(client.entities_search as ReturnType<typeof vi.fn>).mockResolvedValue({
        entities: [{ id: 'ent-001', name: 'QSR Corp', type: 'organization', aliases: ['QSR'], capture_count: 12 }],
        total: 1,
      })
      ;(client.entities_split as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('422'))
      await handleCommand(makeMessage('!entity split QSR Corp QSR'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !board quick / quarterly (governance sessions)
  // -------------------------------------------------------------------------

  describe('!board quick', () => {
    let redis: ReturnType<typeof makeRedis>

    beforeEach(() => {
      redis = makeRedis()
    })

    it('calls sessions_create with governance type', async () => {
      await handleCommand(makeMessage('!board quick'), say, client, redis as never)
      expect(client.sessions_create).toHaveBeenCalledWith('governance')
    })

    it('stores session thread mapping in Redis', async () => {
      await handleCommand(makeMessage('!board quick'), say, client, redis as never)
      expect(redis.set).toHaveBeenCalled()
    })

    it('replies with session start message containing first bot message', async () => {
      await handleCommand(makeMessage('!board quick'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('quick board check')
      expect(call.text).toContain('Board:')
    })

    it('replies in thread', async () => {
      const msg = makeMessage('!board quick', { ts: '9999.0002' })
      await handleCommand(msg, say, client, redis as never)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '9999.0002' }))
    })

    it('warns when Redis unavailable', async () => {
      await handleCommand(makeMessage('!board quick'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Redis unavailable')
    })

    it('handles sessions_create failure gracefully', async () => {
      ;(client.sessions_create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!board quick'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  describe('!board quarterly', () => {
    let redis: ReturnType<typeof makeRedis>

    beforeEach(() => {
      redis = makeRedis()
    })

    it('calls sessions_create with review type', async () => {
      await handleCommand(makeMessage('!board quarterly'), say, client, redis as never)
      expect(client.sessions_create).toHaveBeenCalledWith('review')
    })

    it('replies with session start message', async () => {
      await handleCommand(makeMessage('!board quarterly'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('quarterly review')
    })
  })

  describe('!board status', () => {
    let redis: ReturnType<typeof makeRedis>

    beforeEach(() => {
      redis = makeRedis()
    })

    it('calls sessions_list for both active and paused', async () => {
      await handleCommand(makeMessage('!board status'), say, client, redis as never)
      expect(client.sessions_list).toHaveBeenCalledWith('active', 10)
      expect(client.sessions_list).toHaveBeenCalledWith('paused', 10)
    })

    it('shows session info in reply', async () => {
      await handleCommand(makeMessage('!board status'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Governance Sessions')
    })

    it('shows empty state when no sessions', async () => {
      ;(client.sessions_list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 })
      await handleCommand(makeMessage('!board status'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No active')
    })

    it('handles sessions_list failure gracefully', async () => {
      ;(client.sessions_list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!board status'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  describe('!board resume', () => {
    let redis: ReturnType<typeof makeRedis>

    beforeEach(() => {
      redis = makeRedis()
    })

    it('calls sessions_resume with provided id', async () => {
      await handleCommand(makeMessage('!board resume sess-abc-12345678'), say, client, redis as never)
      expect(client.sessions_resume).toHaveBeenCalledWith('sess-abc-12345678')
    })

    it('replies with resume context message', async () => {
      await handleCommand(makeMessage('!board resume sess-abc-12345678'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('resumed')
    })

    it('warns when no id provided', async () => {
      await handleCommand(makeMessage('!board resume'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('handles sessions_resume failure gracefully', async () => {
      ;(client.sessions_resume as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404'))
      await handleCommand(makeMessage('!board resume bad-id'), say, client, redis as never)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  describe('!board unknown subcommand', () => {
    it('warns on unknown board subcommand', async () => {
      await handleCommand(makeMessage('!board unknown'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })
  })

  // -------------------------------------------------------------------------
  // !bet commands
  // -------------------------------------------------------------------------

  describe('!bet list', () => {
    it('calls bets_list with no status filter by default', async () => {
      await handleCommand(makeMessage('!bet list'), say, client)
      expect(client.bets_list).toHaveBeenCalledWith(undefined, 20)
    })

    it('calls bets_list with status filter when provided', async () => {
      await handleCommand(makeMessage('!bet list pending'), say, client)
      expect(client.bets_list).toHaveBeenCalledWith('pending', 20)
    })

    it('shows bet statement in reply', async () => {
      await handleCommand(makeMessage('!bet list'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('QSR deal closes')
    })

    it('shows empty state when no bets', async () => {
      ;(client.bets_list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 })
      await handleCommand(makeMessage('!bet list'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No bets found')
    })

    it('ignores invalid status filter', async () => {
      await handleCommand(makeMessage('!bet list badstatus'), say, client)
      expect(client.bets_list).toHaveBeenCalledWith(undefined, 20)
    })

    it('handles bets_list failure gracefully', async () => {
      ;(client.bets_list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!bet list'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  describe('!bet add', () => {
    it('calls bets_create with confidence and statement', async () => {
      await handleCommand(makeMessage('!bet add 0.75 QSR deal closes by Q2 2026'), say, client)
      expect(client.bets_create).toHaveBeenCalledWith(
        expect.objectContaining({ confidence: 0.75, statement: 'QSR deal closes by Q2 2026' }),
      )
    })

    it('shows bet creation confirmation', async () => {
      await handleCommand(makeMessage('!bet add 0.75 QSR deal closes by Q2 2026'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Bet recorded')
    })

    it('warns when confidence is missing or invalid', async () => {
      await handleCommand(makeMessage('!bet add bad statement here'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('warns when confidence is out of range', async () => {
      await handleCommand(makeMessage('!bet add 1.5 Some statement'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('warns when statement is missing', async () => {
      await handleCommand(makeMessage('!bet add 0.8'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('statement is required')
    })

    it('handles bets_create failure gracefully', async () => {
      ;(client.bets_create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('422'))
      await handleCommand(makeMessage('!bet add 0.8 Some statement'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  describe('!bet expiring', () => {
    it('calls bets_expiring with default 7 days', async () => {
      await handleCommand(makeMessage('!bet expiring'), say, client)
      expect(client.bets_expiring).toHaveBeenCalledWith(7)
    })

    it('calls bets_expiring with custom days', async () => {
      await handleCommand(makeMessage('!bet expiring 14'), say, client)
      expect(client.bets_expiring).toHaveBeenCalledWith(14)
    })

    it('shows expiring bets in reply', async () => {
      await handleCommand(makeMessage('!bet expiring'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Expiring')
    })

    it('shows empty state when no expiring bets', async () => {
      ;(client.bets_expiring as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], days_ahead: 7 })
      await handleCommand(makeMessage('!bet expiring'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No bets expiring')
    })

    it('handles bets_expiring failure gracefully', async () => {
      ;(client.bets_expiring as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!bet expiring'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  describe('!bet resolve', () => {
    it('calls bets_resolve with id and outcome', async () => {
      await handleCommand(makeMessage('!bet resolve bet-xyz-12345678 correct'), say, client)
      expect(client.bets_resolve).toHaveBeenCalledWith(
        'bet-xyz-12345678',
        expect.objectContaining({ resolution: 'correct' }),
      )
    })

    it('calls bets_resolve with evidence when provided', async () => {
      await handleCommand(makeMessage('!bet resolve bet-xyz-12345678 incorrect Revenue missed by 20%'), say, client)
      expect(client.bets_resolve).toHaveBeenCalledWith(
        'bet-xyz-12345678',
        expect.objectContaining({ resolution: 'incorrect', evidence: 'Revenue missed by 20%' }),
      )
    })

    it('shows resolution confirmation', async () => {
      await handleCommand(makeMessage('!bet resolve bet-xyz-12345678 correct'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('resolved')
    })

    it('warns when no id provided', async () => {
      await handleCommand(makeMessage('!bet resolve'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('warns on invalid outcome', async () => {
      await handleCommand(makeMessage('!bet resolve bet-xyz-12345678 maybe'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Invalid outcome')
    })

    it('handles bets_resolve failure gracefully', async () => {
      ;(client.bets_resolve as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404'))
      await handleCommand(makeMessage('!bet resolve bad-id correct'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  describe('!bet unknown subcommand', () => {
    it('warns on unknown bet subcommand', async () => {
      await handleCommand(makeMessage('!bet blah'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Unknown bet subcommand')
    })
  })

  // -------------------------------------------------------------------------
  // !pipeline status
  // -------------------------------------------------------------------------

  describe('!pipeline status', () => {
    it('calls pipeline_health', async () => {
      await handleCommand(makeMessage('!pipeline status'), say, client)
      expect(client.pipeline_health).toHaveBeenCalled()
    })

    it('shows pipeline queue info in reply', async () => {
      await handleCommand(makeMessage('!pipeline status'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Pipeline Status')
      expect(call.text).toContain('ingest')
    })

    it('warns on unknown pipeline subcommand', async () => {
      await handleCommand(makeMessage('!pipeline blah'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('handles pipeline_health failure gracefully', async () => {
      ;(client.pipeline_health as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!pipeline status'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !retry
  // -------------------------------------------------------------------------

  describe('!retry', () => {
    it('calls captures_retry with capture id', async () => {
      await handleCommand(makeMessage('!retry cap-abc-123'), say, client)
      expect(client.captures_retry).toHaveBeenCalledWith('cap-abc-123')
    })

    it('confirms retry queued', async () => {
      await handleCommand(makeMessage('!retry cap-abc-123'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('cap-abc-123')
      expect(call.text).toContain('retry')
    })

    it('warns when no capture id provided', async () => {
      await handleCommand(makeMessage('!retry'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('handles captures_retry failure gracefully', async () => {
      ;(client.captures_retry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404 not found'))
      await handleCommand(makeMessage('!retry bad-id'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !trigger add
  // -------------------------------------------------------------------------

  describe('!trigger add', () => {
    it('calls triggers_create with quoted trigger text', async () => {
      await handleCommand(makeMessage('!trigger add "QSR timeline"'), say, client)
      expect(client.triggers_create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'QSR timeline', queryText: 'QSR timeline' }),
      )
    })

    it('calls triggers_create with unquoted trigger text', async () => {
      await handleCommand(makeMessage('!trigger add QSR timeline'), say, client)
      expect(client.triggers_create).toHaveBeenCalledWith(
        expect.objectContaining({ queryText: 'QSR timeline' }),
      )
    })

    it('confirms trigger creation with name and threshold', async () => {
      await handleCommand(makeMessage('!trigger add "QSR timeline"'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('QSR timeline')
      expect(call.text).toContain('0.72')
    })

    it('warns when no query text provided', async () => {
      await handleCommand(makeMessage('!trigger add'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('handles triggers_create failure gracefully', async () => {
      ;(client.triggers_create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('422 max triggers'))
      await handleCommand(makeMessage('!trigger add "test"'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !trigger list
  // -------------------------------------------------------------------------

  describe('!trigger list', () => {
    it('calls triggers_list', async () => {
      await handleCommand(makeMessage('!trigger list'), say, client)
      expect(client.triggers_list).toHaveBeenCalled()
    })

    it('shows trigger name and status in reply', async () => {
      await handleCommand(makeMessage('!trigger list'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('QSR timeline')
    })

    it('shows empty state when no triggers', async () => {
      ;(client.triggers_list as ReturnType<typeof vi.fn>).mockResolvedValue({ triggers: [] })
      await handleCommand(makeMessage('!trigger list'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No triggers')
    })

    it('handles triggers_list failure gracefully', async () => {
      ;(client.triggers_list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!trigger list'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !trigger delete
  // -------------------------------------------------------------------------

  describe('!trigger delete', () => {
    it('calls triggers_delete with trigger name', async () => {
      await handleCommand(makeMessage('!trigger delete QSR timeline'), say, client)
      expect(client.triggers_delete).toHaveBeenCalledWith('QSR timeline')
    })

    it('confirms deactivation', async () => {
      await handleCommand(makeMessage('!trigger delete QSR timeline'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('deactivated')
    })

    it('warns when no name provided', async () => {
      await handleCommand(makeMessage('!trigger delete'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('handles triggers_delete failure gracefully', async () => {
      ;(client.triggers_delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404'))
      await handleCommand(makeMessage('!trigger delete bad-name'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !trigger test
  // -------------------------------------------------------------------------

  describe('!trigger test', () => {
    it('calls triggers_test with query text', async () => {
      await handleCommand(makeMessage('!trigger test "QSR timeline"'), say, client)
      expect(client.triggers_test).toHaveBeenCalledWith(
        expect.objectContaining({ query_text: 'QSR timeline', limit: 5 }),
      )
    })

    it('shows top matches without firing', async () => {
      await handleCommand(makeMessage('!trigger test "QSR timeline"'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Trigger Test')
      expect(call.text).toContain('no notification fired')
    })

    it('shows match content in reply', async () => {
      await handleCommand(makeMessage('!trigger test "QSR timeline"'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('QSR deal timeline updated')
    })

    it('shows no-match message when empty results', async () => {
      ;(client.triggers_test as ReturnType<typeof vi.fn>).mockResolvedValue({ query_text: 'obscure', matches: [] })
      await handleCommand(makeMessage('!trigger test "obscure"'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('No matches found')
    })

    it('warns when no query text provided', async () => {
      await handleCommand(makeMessage('!trigger test'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
    })

    it('handles triggers_test failure gracefully', async () => {
      ;(client.triggers_test as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
      await handleCommand(makeMessage('!trigger test "test"'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain(':warning:')
    })
  })

  // -------------------------------------------------------------------------
  // !trigger unknown subcommand
  // -------------------------------------------------------------------------

  describe('!trigger unknown', () => {
    it('warns on unknown trigger subcommand', async () => {
      await handleCommand(makeMessage('!trigger blah'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Unknown trigger subcommand')
    })
  })

  // -------------------------------------------------------------------------
  // !help
  // -------------------------------------------------------------------------

  describe('!help', () => {
    it('replies with help text listing all commands', async () => {
      await handleCommand(makeMessage('!help'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('!stats')
      expect(call.text).toContain('!brief')
      expect(call.text).toContain('!trigger')
      expect(call.text).toContain('!recent')
      expect(call.text).toContain('!pipeline')
      expect(call.text).toContain('merge')
      expect(call.text).toContain('split')
      expect(call.text).toContain('!board quick')
      expect(call.text).toContain('!bet list')
    })

    it('replies in thread', async () => {
      const msg = makeMessage('!help', { ts: '1111.0001' })
      await handleCommand(msg, say, client)
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1111.0001' }))
    })
  })

  // -------------------------------------------------------------------------
  // Unknown command
  // -------------------------------------------------------------------------

  describe('unknown command', () => {
    it('replies with unknown command message', async () => {
      await handleCommand(makeMessage('!foobar'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Unknown command')
      expect(call.text).toContain('!foobar')
    })

    it('suggests !help in unknown command reply', async () => {
      await handleCommand(makeMessage('!xyz'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('!help')
    })
  })
})
