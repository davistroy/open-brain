import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VoiceSessionService } from '../services/voice-session.js'
import type { Database } from '@open-brain/shared'
import type { ActivityFeedService } from '../services/activity-feed.js'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-11T10:00:00Z')

const SAMPLE_SESSION = {
  id: 'vs-uuid-1',
  session_key: 'pipecat-abc123',
  started_at: new Date('2026-04-11T09:00:00Z'),
  ended_at: null,
  duration_seconds: null,
  turn_count: 0,
  transcript: [],
  summary: null,
  captures_created: [],
  metadata: {},
  created_at: new Date('2026-04-11T09:00:00Z'),
}

const COMPLETED_SESSION = {
  ...SAMPLE_SESSION,
  ended_at: NOW,
  duration_seconds: 3600,
  turn_count: 4,
  transcript: [
    { role: 'user', content: 'Hello', timestamp: '2026-04-11T09:00:00Z' },
    { role: 'assistant', content: 'Hi there', timestamp: '2026-04-11T09:00:05Z' },
    { role: 'user', content: 'What did I talk about yesterday?', timestamp: '2026-04-11T09:01:00Z' },
    { role: 'assistant', content: 'You discussed project planning.', timestamp: '2026-04-11T09:01:10Z' },
  ],
  summary: 'Brief conversation about yesterday\'s activities',
  captures_created: ['cap-uuid-1', 'cap-uuid-2'],
}

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as email-draft-service.test.ts)
// ---------------------------------------------------------------------------

function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, any> = {}
  const promise = Promise.resolve(rows)

  for (const method of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn().mockReturnValue(chain)
  }

  chain.then = (resolve: any, reject: any) => promise.then(resolve, reject)
  chain.catch = (reject: any) => promise.catch(reject)

  return chain
}

function makeInsertChain(returning: unknown[] = []) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returning),
    }),
  }
}

function makeUpdateChain(returning: unknown[] = []) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  }
}

function makeDb(opts: {
  selectRowSets?: unknown[][]
  insertRowSets?: unknown[][]
  updateRowSets?: unknown[][]
} = {}): Database {
  const selectSets = [...(opts.selectRowSets ?? [[SAMPLE_SESSION]])]
  const insertSets = [...(opts.insertRowSets ?? [[SAMPLE_SESSION]])]
  const updateSets = [...(opts.updateRowSets ?? [[SAMPLE_SESSION]])]

  return {
    select: vi.fn().mockImplementation(() => {
      const rows = selectSets.shift() ?? []
      return makeSelectChain(rows)
    }),
    insert: vi.fn().mockImplementation(() => {
      const rows = insertSets.shift() ?? []
      return makeInsertChain(rows)
    }),
    update: vi.fn().mockImplementation(() => {
      const rows = updateSets.shift() ?? []
      return makeUpdateChain(rows)
    }),
  } as unknown as Database
}

function makeActivityFeed(): ActivityFeedService {
  return {
    insert: vi.fn().mockResolvedValue({ id: 'feed-1' }),
  } as unknown as ActivityFeedService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceSessionService', () => {
  let activityFeed: ActivityFeedService

  beforeEach(() => {
    activityFeed = makeActivityFeed()
  })

  describe('create', () => {
    it('inserts a new session with session_key', async () => {
      const db = makeDb({ insertRowSets: [[SAMPLE_SESSION]] })
      const service = new VoiceSessionService(db)

      const result = await service.create({ sessionKey: 'pipecat-abc123' })

      expect(result.id).toBe('vs-uuid-1')
      expect(result.session_key).toBe('pipecat-abc123')
      expect(db.insert).toHaveBeenCalled()
    })

    it('accepts optional metadata', async () => {
      const sessionWithMeta = { ...SAMPLE_SESSION, metadata: { client: 'ios-shortcut' } }
      const db = makeDb({ insertRowSets: [[sessionWithMeta]] })
      const service = new VoiceSessionService(db)

      const result = await service.create({
        sessionKey: 'pipecat-abc123',
        metadata: { client: 'ios-shortcut' },
      })

      expect(result.metadata).toEqual({ client: 'ios-shortcut' })
    })

    it('fires activity feed event on create', async () => {
      const db = makeDb({ insertRowSets: [[SAMPLE_SESSION]] })
      const service = new VoiceSessionService(db)
      service.setActivityFeedService(activityFeed)

      await service.create({ sessionKey: 'pipecat-abc123' })

      // Wait for the fire-and-forget activity-feed write (deterministic, not a fixed sleep)
      await vi.waitFor(() => expect(activityFeed.insert).toHaveBeenCalled())

      expect(activityFeed.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voice',
          subtype: 'started',
        }),
      )
    })
  })

  describe('get', () => {
    it('returns session by id', async () => {
      const db = makeDb({ selectRowSets: [[SAMPLE_SESSION]] })
      const service = new VoiceSessionService(db)

      const result = await service.get('vs-uuid-1')
      expect(result.id).toBe('vs-uuid-1')
    })

    it('throws NotFoundError for missing session', async () => {
      const db = makeDb({ selectRowSets: [[]] })
      const service = new VoiceSessionService(db)

      await expect(service.get('nonexistent')).rejects.toThrow('not found')
    })
  })

  describe('update', () => {
    it('updates session fields', async () => {
      const updated = { ...SAMPLE_SESSION, turn_count: 3 }
      const db = makeDb({
        selectRowSets: [[SAMPLE_SESSION]],  // get() check
        updateRowSets: [[updated]],
      })
      const service = new VoiceSessionService(db)

      const result = await service.update('vs-uuid-1', { turn_count: 3 })
      expect(result.turn_count).toBe(3)
      expect(db.update).toHaveBeenCalled()
    })

    it('returns current session if no fields provided', async () => {
      const db = makeDb({
        selectRowSets: [[SAMPLE_SESSION], [SAMPLE_SESSION]],  // get() check, then get() return
      })
      const service = new VoiceSessionService(db)

      const result = await service.update('vs-uuid-1', {})
      expect(result.id).toBe('vs-uuid-1')
      expect(db.update).not.toHaveBeenCalled()
    })

    it('throws NotFoundError if session does not exist', async () => {
      const db = makeDb({ selectRowSets: [[]] })
      const service = new VoiceSessionService(db)

      await expect(service.update('nonexistent', { turn_count: 1 })).rejects.toThrow('not found')
    })
  })

  describe('complete', () => {
    it('marks session as ended with transcript and summary', async () => {
      const db = makeDb({
        selectRowSets: [[SAMPLE_SESSION], [SAMPLE_SESSION]],  // two get() calls
        updateRowSets: [[COMPLETED_SESSION]],
      })
      const service = new VoiceSessionService(db)

      const result = await service.complete(
        'vs-uuid-1',
        COMPLETED_SESSION.transcript as any,
        'Brief conversation about yesterday\'s activities',
        ['cap-uuid-1', 'cap-uuid-2'],
      )

      expect(result.ended_at).not.toBeNull()
      expect(result.summary).toBe('Brief conversation about yesterday\'s activities')
      expect(result.captures_created).toEqual(['cap-uuid-1', 'cap-uuid-2'])
      expect(result.turn_count).toBe(4)
      expect(db.update).toHaveBeenCalled()
    })

    it('fires activity feed event on complete', async () => {
      const db = makeDb({
        selectRowSets: [[SAMPLE_SESSION], [SAMPLE_SESSION]],
        updateRowSets: [[COMPLETED_SESSION]],
      })
      const service = new VoiceSessionService(db)
      service.setActivityFeedService(activityFeed)

      await service.complete(
        'vs-uuid-1',
        COMPLETED_SESSION.transcript as any,
        'Summary',
        [],
      )

      // Wait for the fire-and-forget activity-feed write (deterministic, not a fixed sleep)
      await vi.waitFor(() => expect(activityFeed.insert).toHaveBeenCalled())

      expect(activityFeed.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voice',
          subtype: 'completed',
        }),
      )
    })
  })

  describe('list', () => {
    it('returns paginated results', async () => {
      const db = makeDb({
        selectRowSets: [[SAMPLE_SESSION], [{ count: '1' }]],
      })
      const service = new VoiceSessionService(db)

      const result = await service.list()
      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it('respects limit and offset', async () => {
      const db = makeDb({
        selectRowSets: [[], [{ count: '0' }]],
      })
      const service = new VoiceSessionService(db)

      const result = await service.list(10, 5)
      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(0)
    })
  })

  describe('getActive', () => {
    it('returns sessions where ended_at is null', async () => {
      const db = makeDb({ selectRowSets: [[SAMPLE_SESSION]] })
      const service = new VoiceSessionService(db)

      const result = await service.getActive()
      expect(result).toHaveLength(1)
      expect(result[0]!.ended_at).toBeNull()
    })

    it('returns empty array when no active sessions', async () => {
      const db = makeDb({ selectRowSets: [[]] })
      const service = new VoiceSessionService(db)

      const result = await service.getActive()
      expect(result).toHaveLength(0)
    })
  })
})
