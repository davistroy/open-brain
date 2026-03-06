import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionService } from '../services/session.js'
import { NotFoundError, ValidationError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Minimal mock DB factory — intercepts Drizzle chained calls
// ---------------------------------------------------------------------------

function makeDbMock() {
  // We need to track what gets inserted/updated/selected so tests can assert on it
  const insertedMessages: Record<string, unknown>[] = []
  const updatedSessions: Record<string, unknown>[] = []

  const SAMPLE_SESSION = {
    id: 'session-uuid-1',
    session_type: 'governance',
    status: 'active',
    config: {
      max_turns: 20,
      timeout_ms: 1800000,
      focus_brain_views: [],
      turn_count: 0,
      last_activity_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
    },
    context_capture_ids: [],
    summary: null,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
  }

  const PAUSED_SESSION = {
    ...SAMPLE_SESSION,
    id: 'session-uuid-paused',
    status: 'paused',
    config: {
      ...SAMPLE_SESSION.config,
      paused_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    },
  }

  const EXPIRED_SESSION = {
    ...SAMPLE_SESSION,
    id: 'session-uuid-expired',
    status: 'paused',
    config: {
      ...SAMPLE_SESSION.config,
      paused_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), // 31 days ago
    },
  }

  function chainBuilder(rows: unknown[]) {
    const chain: Record<string, unknown> = {}
    const methods = ['from', 'where', 'orderBy', 'limit', 'offset', 'returning']
    for (const m of methods) {
      chain[m] = () => chain
    }
    // .then() makes it thenable for await
    chain.then = (resolve: (v: unknown) => void) => resolve(rows)
    return chain
  }

  function insertChain(returning: unknown[]) {
    const chain: Record<string, unknown> = {}
    chain.values = (vals: Record<string, unknown>) => {
      insertedMessages.push(vals)
      return {
        returning: () => {
          return {
            then: (resolve: (v: unknown) => void) => resolve(returning),
          }
        },
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      }
    }
    return chain
  }

  function updateChain(returning: unknown[]) {
    const chain: Record<string, unknown> = {}
    chain.set = (vals: Record<string, unknown>) => {
      updatedSessions.push(vals)
      return {
        where: () => ({
          returning: () => ({
            then: (resolve: (v: unknown) => void) => resolve(returning),
          }),
        }),
      }
    }
    return chain
  }

  const db = {
    _insertedMessages: insertedMessages,
    _updatedSessions: updatedSessions,
    _sessions: {
      active: SAMPLE_SESSION,
      paused: PAUSED_SESSION,
      expired: EXPIRED_SESSION,
    },
    // Drizzle chainable select
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            then: (resolve: (v: unknown) => void) => resolve([SAMPLE_SESSION]),
          }),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockReturnValue({
                then: (resolve: (v: unknown) => void) => resolve([SAMPLE_SESSION]),
              }),
            }),
          }),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({
          then: (resolve: (v: unknown) => void) => resolve([SAMPLE_SESSION]),
        }),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockReturnValue({
            then: (resolve: (v: unknown) => void) => resolve([SAMPLE_SESSION]),
          }),
        }),
      }),
    }),
  }

  return db
}

// ---------------------------------------------------------------------------
// Tests — SessionService unit tests using spy/mock pattern
// ---------------------------------------------------------------------------

describe('SessionService', () => {
  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------
  describe('create()', () => {
    it('creates a governance session and returns first message', async () => {
      const db = makeDbMock() as any
      const service = new SessionService(db)

      const result = await service.create({ type: 'governance' })

      expect(result.session).toBeDefined()
      expect(result.first_message).toContain('quick board check')
    })

    it('creates a review session with appropriate opening message', async () => {
      const db = makeDbMock() as any
      const service = new SessionService(db)

      const result = await service.create({ type: 'review' })

      expect(result.first_message).toContain('structured review')
    })

    it('creates a planning session with appropriate opening message', async () => {
      const db = makeDbMock() as any
      const service = new SessionService(db)

      const result = await service.create({ type: 'planning' })

      expect(result.first_message).toContain('plan')
    })

    it('applies custom config (max_turns, focus_brain_views)', async () => {
      const db = makeDbMock() as any
      const insertSpy = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockReturnValue({
            then: (resolve: (v: unknown) => void) => resolve([{
              id: 'test-session-id',
              session_type: 'governance',
              status: 'active',
              config: { max_turns: 5, focus_brain_views: ['technical'] },
              context_capture_ids: [],
              summary: null,
              created_at: new Date(),
              updated_at: new Date(),
              completed_at: null,
            }]),
          }),
          then: (resolve: (v: unknown) => void) => resolve(undefined),
        }),
      })
      db.insert = insertSpy

      const result = await new SessionService(db).create({
        type: 'governance',
        config: { max_turns: 5, focus_brain_views: ['technical'] },
      })

      expect(result.session).toBeDefined()
      // The insert was called — values included our config
      expect(insertSpy).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // respond() — validation cases
  // -------------------------------------------------------------------------
  describe('respond()', () => {
    it('throws ValidationError when session is not active (paused)', async () => {
      const db = makeDbMock() as any

      // Override select to return a paused session
      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-paused',
                session_type: 'governance',
                status: 'paused',
                config: { turn_count: 3 },
                context_capture_ids: [],
                summary: null,
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: null,
              }]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      await expect(service.respond('session-uuid-paused', 'hello')).rejects.toThrow(ValidationError)
    })

    it('throws ValidationError when max_turns exceeded', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-full',
                session_type: 'governance',
                status: 'active',
                config: {
                  max_turns: 5,
                  turn_count: 5,
                  last_activity_at: new Date(Date.now() - 1000).toISOString(),
                },
                context_capture_ids: [],
                summary: null,
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: null,
              }]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      await expect(service.respond('session-uuid-full', 'another message')).rejects.toThrow(ValidationError)
    })
  })

  // -------------------------------------------------------------------------
  // pause() / resume()
  // -------------------------------------------------------------------------
  describe('pause()', () => {
    it('pauses an active session', async () => {
      const db = makeDbMock() as any
      const service = new SessionService(db)

      const result = await service.pause('session-uuid-1')

      expect(result).toBeDefined()
      // db.update was called
      expect(db.update).toHaveBeenCalled()
    })

    it('is idempotent — returns session if already paused', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-paused',
                session_type: 'governance',
                status: 'paused',
                config: { turn_count: 2 },
                context_capture_ids: [],
                summary: null,
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: null,
              }]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      // Should NOT throw, should just return the session as-is
      const result = await service.pause('session-uuid-paused')

      expect(result.status).toBe('paused')
      // update should NOT have been called (early return)
      expect(db.update).not.toHaveBeenCalled()
    })

    it('throws ValidationError when trying to pause a completed session', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-complete',
                session_type: 'governance',
                status: 'complete',
                config: {},
                context_capture_ids: [],
                summary: 'done',
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: new Date(),
              }]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      await expect(service.pause('session-uuid-complete')).rejects.toThrow(ValidationError)
    })
  })

  describe('resume()', () => {
    it('resumes a paused session and returns context message', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-paused',
                session_type: 'governance',
                status: 'paused',
                config: {
                  turn_count: 3,
                  paused_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
                },
                context_capture_ids: [],
                summary: null,
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: null,
              }]),
            }),
            orderBy: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      const result = await service.resume('session-uuid-paused')

      expect(result.session).toBeDefined()
      expect(result.context_message).toContain('Welcome back')
    })

    it('throws ValidationError when session paused > 30 days (auto-expire)', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-expired',
                session_type: 'governance',
                status: 'paused',
                config: {
                  turn_count: 2,
                  paused_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
                },
                context_capture_ids: [],
                summary: null,
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: null,
              }]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      await expect(service.resume('session-uuid-expired')).rejects.toThrow(ValidationError)
    })

    it('throws ValidationError when resuming a non-paused session', async () => {
      const db = makeDbMock() as any
      const service = new SessionService(db)

      // Default mock returns an 'active' session
      await expect(service.resume('session-uuid-1')).rejects.toThrow(ValidationError)
    })
  })

  // -------------------------------------------------------------------------
  // complete()
  // -------------------------------------------------------------------------
  describe('complete()', () => {
    it('completes an active session and returns summary', async () => {
      const db = makeDbMock() as any

      // select needs to return session for getById, then empty messages for transcript
      let selectCallCount = 0
      db.select = vi.fn().mockImplementation(() => {
        selectCallCount++
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                then: (resolve: (v: unknown) => void) => resolve([{
                  id: 'session-uuid-1',
                  session_type: 'governance',
                  status: 'active',
                  config: { turn_count: 3 },
                  context_capture_ids: [],
                  summary: null,
                  created_at: new Date(),
                  updated_at: new Date(),
                  completed_at: null,
                }]),
              }),
              orderBy: vi.fn().mockReturnValue({
                then: (resolve: (v: unknown) => void) => resolve([
                  { id: 'msg-1', session_id: 'session-uuid-1', role: 'user', content: 'test message', metadata: null, created_at: new Date() },
                ]),
              }),
            }),
          }),
        }
      })

      const service = new SessionService(db)

      const result = await service.complete('session-uuid-1')

      expect(result.summary).toBeDefined()
      expect(result.summary).toContain('governance')
      expect(db.update).toHaveBeenCalled()
    })

    it('throws ValidationError when completing an already-abandoned session', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-abandoned',
                session_type: 'governance',
                status: 'abandoned',
                config: {},
                context_capture_ids: [],
                summary: null,
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: null,
              }]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      await expect(service.complete('session-uuid-abandoned')).rejects.toThrow(ValidationError)
    })
  })

  // -------------------------------------------------------------------------
  // abandon()
  // -------------------------------------------------------------------------
  describe('abandon()', () => {
    it('abandons an active session', async () => {
      const db = makeDbMock() as any
      const service = new SessionService(db)

      const result = await service.abandon('session-uuid-1')

      expect(result).toBeDefined()
      expect(db.update).toHaveBeenCalled()
    })

    it('throws ValidationError when abandoning a completed session', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([{
                id: 'session-uuid-complete',
                session_type: 'governance',
                status: 'complete',
                config: {},
                context_capture_ids: [],
                summary: 'done',
                created_at: new Date(),
                updated_at: new Date(),
                completed_at: new Date(),
              }]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      await expect(service.abandon('session-uuid-complete')).rejects.toThrow(ValidationError)
    })
  })

  // -------------------------------------------------------------------------
  // getById() — NotFoundError
  // -------------------------------------------------------------------------
  describe('getById()', () => {
    it('throws NotFoundError when session does not exist', async () => {
      const db = makeDbMock() as any

      db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: (resolve: (v: unknown) => void) => resolve([]),
            }),
          }),
        }),
      })

      const service = new SessionService(db)

      await expect(service.getById('nonexistent-id')).rejects.toThrow(NotFoundError)
    })
  })
})
