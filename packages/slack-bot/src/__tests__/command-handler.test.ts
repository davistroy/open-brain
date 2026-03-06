import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SayFn, GenericMessageEvent } from '@slack/bolt'
import { handleCommand } from '../handlers/command.js'
import type { CoreApiClient, BrainStats, TriggerRecord, TriggerMatch } from '../lib/core-api-client.js'

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
  // !board
  // -------------------------------------------------------------------------

  describe('!board', () => {
    it('responds to !board quick with Phase 13 stub message', async () => {
      await handleCommand(makeMessage('!board quick'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Phase 13')
    })

    it('responds to !board quarterly with Phase 13 stub message', async () => {
      await handleCommand(makeMessage('!board quarterly'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Phase 13')
    })

    it('warns on unknown board subcommand', async () => {
      await handleCommand(makeMessage('!board unknown'), say, client)
      const call = (say as ReturnType<typeof vi.fn>).mock.calls[0][0] as { text: string }
      expect(call.text).toContain('Usage')
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
        expect.objectContaining({ name: 'QSR timeline', query_text: 'QSR timeline' }),
      )
    })

    it('calls triggers_create with unquoted trigger text', async () => {
      await handleCommand(makeMessage('!trigger add QSR timeline'), say, client)
      expect(client.triggers_create).toHaveBeenCalledWith(
        expect.objectContaining({ query_text: 'QSR timeline' }),
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
