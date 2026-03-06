import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  processCheckTriggersJob,
  cosineSimilarity,
  invalidateTriggerCache,
} from '../jobs/check-triggers.js'
import type { CheckTriggersJobData } from '../queues/check-triggers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a 768-element unit vector with a constant value.
 * (All values equal 1/sqrt(768) gives magnitude 1 — normalized.)
 */
function unitVector(value = 1): number[] {
  const len = 768
  const mag = Math.sqrt(len * value * value)
  return new Array(len).fill(value / mag)
}

/**
 * Fluent select chain mock for Drizzle ORM.
 */
function selectChain(rows: unknown[]) {
  const terminal = Promise.resolve(rows)
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(terminal)
  // Make chain itself thenable so queries that don't end in .limit() resolve correctly
  ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal.then(resolve, reject)
  ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
  return chain
}

/**
 * Build a mock database with configurable select/update behavior.
 */
function makeMockDb(captureRow?: Record<string, unknown>, triggerRows?: Record<string, unknown>[]) {
  const defaultCapture = {
    id: 'cap-1',
    content: 'QSR project timeline is very compressed this quarter',
    embedding: unitVector(0.5),
    pipeline_status: 'complete',
  }

  const defaultTrigger = {
    id: 'trigger-1',
    name: 'QSR timeline',
    condition_text: 'QSR timeline urgent compressed',
    embedding: unitVector(0.5), // same direction → similarity ~1.0
    threshold: 0.72,
    action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
    last_triggered_at: null,
    trigger_count: 0,
  }

  let selectCallCount = 0

  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++
      if (selectCallCount === 1) {
        // Capture select (first call in processCheckTriggersJob)
        return selectChain(captureRow ? [captureRow] : [defaultCapture])
      }
      // Trigger select (refresh from DB)
      return selectChain(triggerRows ?? [defaultTrigger])
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    _selectCallCount: () => selectCallCount,
  }
}

/**
 * Build a mock PushoverService with isConfigured = true.
 */
function makeMockPushoverService(sendImpl?: () => Promise<void>) {
  return {
    isConfigured: true,
    send: vi.fn().mockImplementation(sendImpl ?? (() => Promise.resolve())),
  }
}

// ---------------------------------------------------------------------------
// cosineSimilarity unit tests
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical normalized vectors', () => {
    const v = unitVector(0.5)
    const result = cosineSimilarity(v, v)
    expect(result).toBeCloseTo(1.0, 5)
  })

  it('returns ~0 for orthogonal vectors', () => {
    const a = new Array(768).fill(0)
    const b = new Array(768).fill(0)
    a[0] = 1
    b[1] = 1 // orthogonal
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5)
  })

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('returns 0 for mismatched dimension vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
  })

  it('returns ~-1 for opposite vectors', () => {
    const v = unitVector(0.5)
    const neg = v.map(x => -x)
    expect(cosineSimilarity(v, neg)).toBeCloseTo(-1.0, 5)
  })
})

// ---------------------------------------------------------------------------
// processCheckTriggersJob — happy path
// ---------------------------------------------------------------------------

describe('processCheckTriggersJob — trigger match fires notification', () => {
  beforeEach(() => {
    invalidateTriggerCache()
    vi.clearAllMocks()
  })

  it('fires Pushover notification when similarity >= threshold', async () => {
    const db = makeMockDb()
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).toHaveBeenCalledOnce()
    const call = pushover.send.mock.calls[0][0]
    expect(call.title).toContain('QSR timeline')
    expect(call.priority).toBe(0)
    // DB update should record the fire
    expect(db.update).toHaveBeenCalled()
  })

  it('does not fire when similarity < threshold', async () => {
    // Trigger expects similarity >= 0.9 but vectors are orthogonal
    const triggerRow = {
      id: 'trigger-2',
      name: 'High threshold trigger',
      condition_text: 'very specific different topic',
      embedding: unitVector(0.9), // different direction from capture
      threshold: 0.9,
      action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
      last_triggered_at: null,
      trigger_count: 0,
    }

    // Make capture and trigger embeddings orthogonal: different axes
    const captureEmbedding = new Array(768).fill(0)
    captureEmbedding[0] = 1
    const triggerEmbedding = new Array(768).fill(0)
    triggerEmbedding[1] = 1 // orthogonal — similarity ~0

    const captureRow = {
      id: 'cap-1',
      content: 'Some unrelated content',
      embedding: captureEmbedding,
      pipeline_status: 'complete',
    }

    const db = makeMockDb(captureRow, [{ ...triggerRow, embedding: triggerEmbedding }])
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// processCheckTriggersJob — cooldown enforcement
// ---------------------------------------------------------------------------

describe('processCheckTriggersJob — cooldown enforcement', () => {
  beforeEach(() => {
    invalidateTriggerCache()
    vi.clearAllMocks()
  })

  it('skips trigger when within cooldown window', async () => {
    const recentlyFiredTrigger = {
      id: 'trigger-1',
      name: 'QSR timeline',
      condition_text: 'QSR project timeline',
      embedding: unitVector(0.5), // same direction as capture — high similarity
      threshold: 0.5, // low threshold — would fire if not in cooldown
      action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
      last_triggered_at: new Date(Date.now() - 30 * 60 * 1000), // fired 30 min ago
      trigger_count: 5,
    }

    const db = makeMockDb(undefined, [recentlyFiredTrigger])
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    // Cooldown not expired (30 min < 60 min) — should not fire
    expect(pushover.send).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('fires trigger when cooldown has elapsed', async () => {
    const expiredCooldownTrigger = {
      id: 'trigger-1',
      name: 'QSR timeline',
      condition_text: 'QSR project timeline',
      embedding: unitVector(0.5), // same direction as capture
      threshold: 0.5, // low threshold — will fire
      action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
      last_triggered_at: new Date(Date.now() - 90 * 60 * 1000), // fired 90 min ago — cooldown expired
      trigger_count: 3,
    }

    const db = makeMockDb(undefined, [expiredCooldownTrigger])
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).toHaveBeenCalledOnce()
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// processCheckTriggersJob — no match → no-op
// ---------------------------------------------------------------------------

describe('processCheckTriggersJob — no match', () => {
  beforeEach(() => {
    invalidateTriggerCache()
    vi.clearAllMocks()
  })

  it('completes silently when no triggers are active', async () => {
    const db = makeMockDb(undefined, []) // no active triggers
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('completes silently when capture is not found', async () => {
    let selectCallCount = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++
        return selectChain([]) // always returns empty
      }),
      update: vi.fn(),
      insert: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    }

    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'missing-cap' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('completes silently when capture has no embedding', async () => {
    const captureWithoutEmbedding = {
      id: 'cap-1',
      content: 'Some content',
      embedding: null, // no embedding yet
      pipeline_status: 'pending',
    }

    const db = makeMockDb(captureWithoutEmbedding)
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('skips trigger with no embedding', async () => {
    const triggerWithoutEmbedding = {
      id: 'trigger-1',
      name: 'Incomplete trigger',
      condition_text: 'some text',
      embedding: null, // no embedding
      threshold: 0.72,
      action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
      last_triggered_at: null,
      trigger_count: 0,
    }

    const db = makeMockDb(undefined, [triggerWithoutEmbedding])
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// processCheckTriggersJob — cache refresh behavior
// ---------------------------------------------------------------------------

describe('processCheckTriggersJob — trigger cache', () => {
  beforeEach(() => {
    invalidateTriggerCache()
    vi.clearAllMocks()
  })

  afterEach(() => {
    invalidateTriggerCache()
  })

  it('refreshes cache from DB on first call (cold start)', async () => {
    const db = makeMockDb()
    const pushover = makeMockPushoverService()
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    // DB should have been queried twice: once for capture, once for triggers
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('uses cached triggers on second call within TTL', async () => {
    // Use orthogonal vectors so trigger does NOT fire (similarity ~0 < threshold 0.72)
    // This prevents fireTrigger() from invalidating the cache between the two calls.
    const captureRow = {
      id: 'cap-1',
      content: 'Some content',
      embedding: (() => { const v = new Array(768).fill(0); v[0] = 1; return v })(),
      pipeline_status: 'complete',
    }
    const triggerRow = [{
      id: 'trigger-1',
      name: 'QSR timeline',
      condition_text: 'QSR project timeline',
      embedding: (() => { const v = new Array(768).fill(0); v[1] = 1; return v })(), // orthogonal
      threshold: 0.72,
      action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
      last_triggered_at: null,
      trigger_count: 0,
    }]

    // First call — populates cache
    const db1 = makeMockDb(captureRow, triggerRow)
    const pushover = makeMockPushoverService()
    await processCheckTriggersJob({ captureId: 'cap-1' }, db1 as any, pushover as any)

    // Second call with fresh db mock — triggers should come from cache, not DB
    const db2 = makeMockDb(captureRow, triggerRow)
    await processCheckTriggersJob({ captureId: 'cap-1' }, db2 as any, pushover as any)

    // db2 should only be queried once (for the capture), not twice (triggers come from cache)
    expect(db2.select).toHaveBeenCalledTimes(1)
  })

  it('invalidateTriggerCache forces DB refresh on next call', async () => {
    // First call — populates cache
    const db1 = makeMockDb()
    const pushover = makeMockPushoverService()
    await processCheckTriggersJob({ captureId: 'cap-1' }, db1 as any, pushover as any)

    // Invalidate cache
    invalidateTriggerCache()

    // Second call — should query DB again for triggers
    const db2 = makeMockDb()
    await processCheckTriggersJob({ captureId: 'cap-1' }, db2 as any, pushover as any)

    // db2 should be queried twice: capture + triggers
    expect(db2.select).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// processCheckTriggersJob — Pushover failure is non-fatal
// ---------------------------------------------------------------------------

describe('processCheckTriggersJob — Pushover failure handling', () => {
  beforeEach(() => {
    invalidateTriggerCache()
    vi.clearAllMocks()
  })

  it('still updates DB trigger record even when Pushover send fails', async () => {
    const db = makeMockDb()
    const pushover = {
      isConfigured: true,
      send: vi.fn().mockRejectedValue(new Error('Pushover API error 429')),
    }
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    // Should NOT throw — Pushover failure is non-fatal
    await expect(
      processCheckTriggersJob(data, db as any, pushover as any),
    ).resolves.toBeUndefined()

    // DB update for trigger fire count still occurs
    expect(db.update).toHaveBeenCalled()
  })

  it('silently skips Pushover when not configured', async () => {
    const db = makeMockDb()
    const pushover = {
      isConfigured: false,
      send: vi.fn(),
    }
    const data: CheckTriggersJobData = { captureId: 'cap-1' }

    await processCheckTriggersJob(data, db as any, pushover as any)

    expect(pushover.send).not.toHaveBeenCalled()
    // DB update still fires (trigger matched and fired, just no notification sent)
    expect(db.update).toHaveBeenCalled()
  })
})
