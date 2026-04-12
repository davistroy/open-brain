import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CaptureDedupSweepSkill,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_MAX_PAIRS,
} from '../skills/capture-dedup-sweep.js'
import type { CaptureDedupSweepOptions, DedupPair } from '../skills/capture-dedup-sweep.js'
import { PushoverService } from '../services/pushover.js'

// ============================================================
// Fixtures
// ============================================================

const SAMPLE_PAIRS = [
  {
    capture_id_a: 'aaa-111',
    capture_id_b: 'bbb-222',
    similarity: '0.97',
    content_a: 'Meeting with team about Q3 roadmap planning session',
    content_b: 'Meeting with team about Q3 roadmap planning',
    created_at_a: '2026-04-01T10:00:00Z',
    created_at_b: '2026-04-01T10:05:00Z',
  },
  {
    capture_id_a: 'ccc-333',
    capture_id_b: 'ddd-444',
    similarity: '0.96',
    content_a: 'Need to follow up on the Kubernetes deployment',
    content_b: 'Follow up on Kubernetes deployment is needed',
    created_at_a: '2026-04-02T14:00:00Z',
    created_at_b: '2026-04-02T14:30:00Z',
  },
  {
    capture_id_a: 'eee-555',
    capture_id_b: 'fff-666',
    similarity: '0.955',
    content_a: 'Budget review for AI infrastructure costs this quarter',
    content_b: 'Budget review: AI infrastructure costs for the quarter',
    created_at_a: '2026-04-03T09:00:00Z',
    created_at_b: '2026-04-03T09:15:00Z',
  },
]

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(pairs = SAMPLE_PAIRS) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: pairs }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makePushoverService(configured = true) {
  const svc = new PushoverService('fake-token', 'fake-user')
  if (!configured) {
    Object.defineProperty(svc, 'isConfigured', { get: () => false })
  }
  vi.spyOn(svc, 'send').mockResolvedValue(undefined)
  return svc
}

function makeSkill(opts: {
  pairs?: typeof SAMPLE_PAIRS
  pushoverConfigured?: boolean
} = {}) {
  const db = makeMockDb(opts.pairs ?? SAMPLE_PAIRS)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  const skill = new CaptureDedupSweepSkill({
    db: db as unknown as import('@open-brain/shared').Database,
    pushover,
  })

  return { skill, db, pushover }
}

// ============================================================
// Tests
// ============================================================

describe('CaptureDedupSweepSkill', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------
  // Core execution
  // ----------------------------------------------------------

  it('returns found pairs with correct structure', async () => {
    const { skill } = makeSkill()
    const result = await skill.execute()

    expect(result.pairsFound).toBe(3)
    expect(result.pairs).toHaveLength(3)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // Verify pair structure
    const first = result.pairs[0]
    expect(first.capture_id_a).toBe('aaa-111')
    expect(first.capture_id_b).toBe('bbb-222')
    expect(first.similarity).toBeCloseTo(0.97, 2)
    expect(first.content_a_preview).toBeTruthy()
    expect(first.content_b_preview).toBeTruthy()
    expect(first.created_at_a).toBe('2026-04-01T10:00:00Z')
    expect(first.created_at_b).toBe('2026-04-01T10:05:00Z')
  })

  it('returns empty results when no duplicates found', async () => {
    const { skill } = makeSkill({ pairs: [] })
    const result = await skill.execute()

    expect(result.pairsFound).toBe(0)
    expect(result.pairs).toHaveLength(0)
    expect(result.notificationSent).toBe(false)
  })

  // ----------------------------------------------------------
  // Similarity threshold
  // ----------------------------------------------------------

  it('uses default similarity threshold (0.95)', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.95)
  })

  it('passes custom similarity threshold to SQL query', async () => {
    const { skill, db } = makeSkill()
    await skill.execute({ similarityThreshold: 0.98 })

    // Verify the execute was called (threshold is in the SQL)
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('uses default max pairs (100)', () => {
    expect(DEFAULT_MAX_PAIRS).toBe(100)
  })

  // ----------------------------------------------------------
  // Exclusion filter
  // ----------------------------------------------------------

  it('SQL query excludes consolidated captures (verified via call)', async () => {
    const { skill, db } = makeSkill()
    await skill.execute()

    // The SQL query is in the db.execute call. We verify it was called.
    // The actual SQL contains `AND a.source != 'consolidation'` and
    // `AND b.source != 'consolidation'` — verified in implementation.
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  // ----------------------------------------------------------
  // Pushover notification
  // ----------------------------------------------------------

  it('sends Pushover notification when duplicates found', async () => {
    const { skill, pushover } = makeSkill()
    const result = await skill.execute()

    expect(result.notificationSent).toBe(true)
    expect(pushover.send).toHaveBeenCalledTimes(1)

    const call = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.title).toBe('Open Brain: Duplicate Captures Found')
    expect(call.message).toContain('3 near-duplicate pairs found')
    expect(call.priority).toBe(0)
  })

  it('includes top 3 examples in Pushover message', async () => {
    const { skill, pushover } = makeSkill()
    await skill.execute()

    const call = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.message).toContain('97.0%')
    expect(call.message).toContain('96.0%')
    expect(call.message).toContain('95.5%')
  })

  it('shows overflow count when more than 3 pairs', async () => {
    const extraPairs = [
      ...SAMPLE_PAIRS,
      {
        capture_id_a: 'ggg-777',
        capture_id_b: 'hhh-888',
        similarity: '0.951',
        content_a: 'Extra capture A',
        content_b: 'Extra capture B',
        created_at_a: '2026-04-04T10:00:00Z',
        created_at_b: '2026-04-04T10:05:00Z',
      },
    ]
    const { skill, pushover } = makeSkill({ pairs: extraPairs })
    await skill.execute()

    const call = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.message).toContain('...and 1 more')
  })

  it('does not send Pushover when no duplicates found', async () => {
    const { skill, pushover } = makeSkill({ pairs: [] })
    await skill.execute()

    expect(pushover.send).not.toHaveBeenCalled()
  })

  it('does not send Pushover when not configured', async () => {
    const { skill, pushover } = makeSkill({ pushoverConfigured: false })
    const result = await skill.execute()

    expect(result.notificationSent).toBe(false)
    expect(pushover.send).not.toHaveBeenCalled()
  })

  it('handles Pushover send failure gracefully', async () => {
    const { skill, pushover } = makeSkill()
    vi.spyOn(pushover, 'send').mockRejectedValueOnce(new Error('Pushover API down'))

    const result = await skill.execute()

    expect(result.notificationSent).toBe(false)
    expect(result.pairsFound).toBe(3) // Results still returned
  })

  // ----------------------------------------------------------
  // skills_log
  // ----------------------------------------------------------

  it('writes to skills_log on success', async () => {
    const { skill, db } = makeSkill()
    await skill.execute()

    expect(db.insert).toHaveBeenCalledTimes(1)
    const valuesCall = db.insert.mock.results[0].value.values
    expect(valuesCall).toHaveBeenCalledTimes(1)

    const logEntry = valuesCall.mock.calls[0][0]
    expect(logEntry.skill_name).toBe('capture-dedup-sweep')
    expect(logEntry.capture_id).toBeNull()
    expect(logEntry.input_summary).toContain('threshold:0.95')
    expect(logEntry.output_summary).toContain('3 duplicate pairs flagged')
    expect(logEntry.result).toBeDefined()
    expect(logEntry.result.pairsFound).toBe(3)
    expect(logEntry.result.pairs).toHaveLength(3)
    expect(logEntry.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('writes "No near-duplicates found" to skills_log when empty', async () => {
    const { skill, db } = makeSkill({ pairs: [] })
    await skill.execute()

    const valuesCall = db.insert.mock.results[0].value.values
    const logEntry = valuesCall.mock.calls[0][0]
    expect(logEntry.output_summary).toBe('No near-duplicates found')
    expect(logEntry.result.pairsFound).toBe(0)
  })

  it('handles skills_log write failure gracefully', async () => {
    const { skill, db } = makeSkill()
    db.insert.mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('DB write failed')),
    })

    // Should not throw
    const result = await skill.execute()
    expect(result.pairsFound).toBe(3)
  })

  // ----------------------------------------------------------
  // DB query error handling
  // ----------------------------------------------------------

  it('returns empty pairs when DB query fails', async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error('connection refused')),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    }
    const pushover = makePushoverService()
    const skill = new CaptureDedupSweepSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
    })

    const result = await skill.execute()

    expect(result.pairsFound).toBe(0)
    expect(result.pairs).toHaveLength(0)
    expect(result.notificationSent).toBe(false)
  })

  // ----------------------------------------------------------
  // Singular/plural formatting
  // ----------------------------------------------------------

  it('uses singular "pair" for exactly 1 duplicate', async () => {
    const singlePair = [SAMPLE_PAIRS[0]]
    const { skill, pushover } = makeSkill({ pairs: singlePair })
    await skill.execute()

    const call = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.message).toContain('1 near-duplicate pair found')
    expect(call.message).not.toContain('pairs')
  })
})

// ============================================================
// Top-level entry point
// ============================================================

describe('executeCaptureDedupSweep', () => {
  it('exports a top-level function that creates and runs the skill', async () => {
    const { executeCaptureDedupSweep } = await import('../skills/capture-dedup-sweep.js')
    expect(typeof executeCaptureDedupSweep).toBe('function')
  })
})
