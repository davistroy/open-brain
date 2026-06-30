import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CaptureDedupSweepSkill,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_MAX_PAIRS,
} from '../skills/capture-dedup-sweep.js'
import type { CaptureDedupSweepOptions, DedupPair } from '../skills/capture-dedup-sweep.js'
import { PushoverService } from '../services/pushover.js'
import {
  findSimilarPairs,
  readScanWatermark,
  writeScanWatermark,
  type SimilarPair,
} from '../lib/hnsw-similarity.js'

// The k-NN scan + scan watermark are unit-isolated here (their own tests live in
// hnsw-similarity.test.ts). This file exercises the skill's orchestration: turning
// scanned pairs into hydrated DedupPairs, notifying, and logging.
vi.mock('../lib/hnsw-similarity.js', () => ({
  findSimilarPairs: vi.fn(),
  readScanWatermark: vi.fn().mockResolvedValue(null), // null = full scan
  writeScanWatermark: vi.fn().mockResolvedValue(undefined),
  CAPTURE_DEDUP_WATERMARK_KEY: 'capture_dedup_last_scan_at',
}))

// ============================================================
// Fixtures
// ============================================================

// What the k-NN scan returns (canonical id pairs + similarity).
const SIM_PAIRS: SimilarPair[] = [
  { capture_id_a: 'aaa-111', capture_id_b: 'bbb-222', similarity: 0.97 },
  { capture_id_a: 'ccc-333', capture_id_b: 'ddd-444', similarity: 0.96 },
  { capture_id_a: 'eee-555', capture_id_b: 'fff-666', similarity: 0.955 },
]

// What the hydration query returns (content/created_at previews keyed by id).
const HYDRATION_ROWS = [
  { id: 'aaa-111', content: 'Meeting with team about Q3 roadmap planning session', created_at: '2026-04-01T10:00:00Z' },
  { id: 'bbb-222', content: 'Meeting with team about Q3 roadmap planning', created_at: '2026-04-01T10:05:00Z' },
  { id: 'ccc-333', content: 'Need to follow up on the Kubernetes deployment', created_at: '2026-04-02T14:00:00Z' },
  { id: 'ddd-444', content: 'Follow up on Kubernetes deployment is needed', created_at: '2026-04-02T14:30:00Z' },
  { id: 'eee-555', content: 'Budget review for AI infrastructure costs this quarter', created_at: '2026-04-03T09:00:00Z' },
  { id: 'fff-666', content: 'Budget review: AI infrastructure costs for the quarter', created_at: '2026-04-03T09:15:00Z' },
]

// ============================================================
// Mock helpers
// ============================================================

function makeMockDb(hydrationRows: typeof HYDRATION_ROWS = HYDRATION_ROWS) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: hydrationRows }), // hydration query
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
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
  simPairs?: SimilarPair[]
  hydrationRows?: typeof HYDRATION_ROWS
  pushoverConfigured?: boolean
} = {}) {
  const simPairs = opts.simPairs ?? SIM_PAIRS
  const db = makeMockDb(opts.hydrationRows ?? HYDRATION_ROWS)
  const pushover = makePushoverService(opts.pushoverConfigured ?? true)

  vi.mocked(findSimilarPairs).mockResolvedValue(simPairs)
  vi.mocked(readScanWatermark).mockResolvedValue(null)
  vi.mocked(writeScanWatermark).mockResolvedValue(undefined)

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
    const { skill } = makeSkill({ simPairs: [] })
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

  it('passes custom similarity threshold to the k-NN scan', async () => {
    const { skill } = makeSkill()
    await skill.execute({ similarityThreshold: 0.98 })

    expect(findSimilarPairs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threshold: 0.98 }),
    )
  })

  it('uses default max pairs (100)', () => {
    expect(DEFAULT_MAX_PAIRS).toBe(100)
  })

  // ----------------------------------------------------------
  // Exclusion filter
  // ----------------------------------------------------------

  it('excludes consolidated captures via excludeConsolidationSource', async () => {
    const { skill } = makeSkill()
    await skill.execute()

    // The dedup sweep must exclude source='consolidation' (parity with the old self-join).
    expect(findSimilarPairs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludeConsolidationSource: true }),
    )
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
    const extraSimPairs: SimilarPair[] = [
      ...SIM_PAIRS,
      { capture_id_a: 'ggg-777', capture_id_b: 'hhh-888', similarity: 0.951 },
    ]
    const extraHydration = [
      ...HYDRATION_ROWS,
      { id: 'ggg-777', content: 'Extra capture A', created_at: '2026-04-04T10:00:00Z' },
      { id: 'hhh-888', content: 'Extra capture B', created_at: '2026-04-04T10:05:00Z' },
    ]
    const { skill, pushover } = makeSkill({ simPairs: extraSimPairs, hydrationRows: extraHydration })
    await skill.execute()

    const call = (pushover.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.message).toContain('...and 1 more')
  })

  it('does not send Pushover when no duplicates found', async () => {
    const { skill, pushover } = makeSkill({ simPairs: [] })
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
    const { skill, db } = makeSkill({ simPairs: [] })
    await skill.execute()

    const valuesCall = db.insert.mock.results[0].value.values
    const logEntry = valuesCall.mock.calls[0][0]
    expect(logEntry.output_summary).toBe('No near-duplicates found')
    expect(logEntry.result.pairsFound).toBe(0)
  })

  it('handles skills_log write failure gracefully', async () => {
    const { skill, db } = makeSkill()
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('DB write failed')) }),
    })

    // Should not throw
    const result = await skill.execute()
    expect(result.pairsFound).toBe(3)
  })

  // ----------------------------------------------------------
  // DB query error handling
  // ----------------------------------------------------------

  it('propagates a scan failure and does NOT advance the watermark', async () => {
    // A scan DB error must surface as a skill failure (→ BullMQ retry), not a
    // silent empty result, and the watermark must not advance (else the un-scanned
    // captures would be permanently skipped).
    const db = makeMockDb()
    const pushover = makePushoverService()
    vi.mocked(readScanWatermark).mockResolvedValue(null)
    vi.mocked(findSimilarPairs).mockRejectedValue(new Error('connection refused'))
    const skill = new CaptureDedupSweepSkill({
      db: db as unknown as import('@open-brain/shared').Database,
      pushover,
    })

    await expect(skill.execute()).rejects.toThrow('connection refused')
    expect(writeScanWatermark).not.toHaveBeenCalled()
    expect(pushover.send).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------
  // Singular/plural formatting
  // ----------------------------------------------------------

  it('uses singular "pair" for exactly 1 duplicate', async () => {
    const { skill, pushover } = makeSkill({ simPairs: [SIM_PAIRS[0]] })
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
