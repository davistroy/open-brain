import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { processDailySweepJob } from '../jobs/daily-sweep.js'
import type { DailySweepJobData } from '../jobs/daily-sweep.js'

// ============================================================
// Mock logger to suppress test output
// ============================================================
vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-brain/shared')>()
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

// ============================================================
// Fixtures
// ============================================================

const JOB_DATA: DailySweepJobData = { triggeredAt: '2026-06-11T03:00:00Z' }

const STUCK_PENDING = { id: '00000000-0000-0000-0000-000000000001' }
const STUCK_EXTRACTED = { id: '00000000-0000-0000-0000-000000000002' }

// ============================================================
// Mock helpers
// ============================================================

/**
 * Mocks the db.select().from().where() chain, capturing the where
 * expression so tests can render it to SQL and inspect bound params.
 */
function makeMockDb(rows: Array<{ id: string }>) {
  const where = vi.fn().mockResolvedValue(rows)
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  return { select, _where: where }
}

function makeMockQueue(shouldFailForId?: string) {
  return {
    add: vi.fn().mockImplementation(async (_name: string, data: { captureId: string }) => {
      if (shouldFailForId && data.captureId === shouldFailForId) {
        throw new Error('BullMQ connection error')
      }
      return { id: data.captureId }
    }),
  }
}

function renderWhereParams(db: ReturnType<typeof makeMockDb>): unknown[] {
  const whereExpr = db._where.mock.calls[0][0]
  return new PgDialect().sqlToQuery(whereExpr).params
}

// ============================================================
// Tests
// ============================================================

describe('processDailySweepJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ----------------------------------------------------------
  // SE-1 regression: sweep must target real stuck statuses
  // ----------------------------------------------------------

  it('sweeps pending, processing, and extracted captures (SE-1)', async () => {
    const db = makeMockDb([])

    await processDailySweepJob(JOB_DATA, db as any, makeMockQueue() as any)

    const params = renderWhereParams(db)
    expect(params).toContain('pending')
    expect(params).toContain('processing')
    expect(params).toContain('extracted')
  })

  it("does not filter on 'received' — a pipeline_events stage, not a capture status (SE-1)", async () => {
    const db = makeMockDb([])

    await processDailySweepJob(JOB_DATA, db as any, makeMockQueue() as any)

    expect(renderWhereParams(db)).not.toContain('received')
  })

  // ----------------------------------------------------------
  // Re-enqueue behavior
  // ----------------------------------------------------------

  it('re-enqueues each stuck capture with jobId = captureId for dedup', async () => {
    const db = makeMockDb([STUCK_PENDING, STUCK_EXTRACTED])
    const queue = makeMockQueue()

    await processDailySweepJob(JOB_DATA, db as any, queue as any)

    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add).toHaveBeenCalledWith(
      'ingest',
      { captureId: STUCK_PENDING.id },
      { jobId: STUCK_PENDING.id },
    )
    expect(queue.add).toHaveBeenCalledWith(
      'ingest',
      { captureId: STUCK_EXTRACTED.id },
      { jobId: STUCK_EXTRACTED.id },
    )
  })

  it('continues re-enqueuing remaining captures when one enqueue fails', async () => {
    const db = makeMockDb([STUCK_PENDING, STUCK_EXTRACTED])
    const queue = makeMockQueue(STUCK_PENDING.id)

    await expect(
      processDailySweepJob(JOB_DATA, db as any, queue as any),
    ).resolves.toBeUndefined()

    expect(queue.add).toHaveBeenCalledTimes(2)
  })

  it('does not enqueue anything when no stuck captures found', async () => {
    const db = makeMockDb([])
    const queue = makeMockQueue()

    await processDailySweepJob(JOB_DATA, db as any, queue as any)

    expect(queue.add).not.toHaveBeenCalled()
  })
})
