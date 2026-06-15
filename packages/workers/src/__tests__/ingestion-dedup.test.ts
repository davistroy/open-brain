import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processIngestionJob } from '../jobs/ingestion-worker.js'
import { IngestDedup } from '../lib/ingest-dedup.js'

// ============================================================
// Mocks
// ============================================================

function makeCapture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-1',
    content_hash: 'hash-abc-123',
    pipeline_status: 'pending',
    pipeline_attempts: 0,
    ...overrides,
  }
}

function makeDb(capture?: ReturnType<typeof makeCapture>) {
  const updateSetWhere = vi.fn().mockResolvedValue(undefined)
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere })
  const updateFn = vi.fn().mockReturnValue({ set: updateSet })

  const insertValues = vi.fn().mockResolvedValue(undefined)
  const insertFn = vi.fn().mockReturnValue({ values: insertValues })

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(capture ? [capture] : []),
        }),
      }),
    }),
    insert: insertFn,
    update: updateFn,
    _updateSetWhere: updateSetWhere,
    _updateSet: updateSet,
    _insertValues: insertValues,
  }
}

function makeFlowProducer() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
  }
}

function makeDedup(isDuplicate: boolean) {
  return {
    isDuplicate: vi.fn().mockResolvedValue(isDuplicate),
  } as unknown as IngestDedup
}

// ============================================================
// Tests
// ============================================================

describe('processIngestionJob — content hash dedup', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('skips pipeline when dedup detects duplicate content hash', async () => {
    const capture = makeCapture()
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()
    const dedup = makeDedup(true) // isDuplicate returns true

    await processIngestionJob(
      { captureId: 'cap-1' },
      db as never,
      flowProducer as never,
      dedup,
    )

    // Should have checked dedup — captureId is now part of the call signature
    expect(dedup.isDuplicate).toHaveBeenCalledWith('hash-abc-123', 'cap-1')

    // Should NOT have enqueued flow DAG
    expect(flowProducer.add).not.toHaveBeenCalled()

    // Should NOT have updated pipeline_status to 'processing'
    // (no update calls after the terminal status check)
    expect(db.update).not.toHaveBeenCalled()
  })

  it('proceeds with pipeline when dedup says content is new', async () => {
    const capture = makeCapture()
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()
    const dedup = makeDedup(false) // isDuplicate returns false

    await processIngestionJob(
      { captureId: 'cap-1' },
      db as never,
      flowProducer as never,
      dedup,
    )

    expect(dedup.isDuplicate).toHaveBeenCalledWith('hash-abc-123', 'cap-1')

    // Should have proceeded to enqueue flow DAG
    expect(flowProducer.add).toHaveBeenCalled()
  })

  it('proceeds normally when no dedup service is provided', async () => {
    const capture = makeCapture()
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()

    await processIngestionJob(
      { captureId: 'cap-1' },
      db as never,
      flowProducer as never,
      undefined, // no dedup
    )

    // Should have proceeded to enqueue flow DAG
    expect(flowProducer.add).toHaveBeenCalled()
  })

  it('proceeds when capture has no content_hash (edge case)', async () => {
    const capture = makeCapture({ content_hash: '' })
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()
    const dedup = makeDedup(false)

    await processIngestionJob(
      { captureId: 'cap-1' },
      db as never,
      flowProducer as never,
      dedup,
    )

    // Empty content_hash is falsy — dedup should be skipped
    expect(dedup.isDuplicate).not.toHaveBeenCalled()
    expect(flowProducer.add).toHaveBeenCalled()
  })

  it('still skips terminal captures before dedup check', async () => {
    const capture = makeCapture({ pipeline_status: 'complete' })
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()
    const dedup = makeDedup(false)

    await processIngestionJob(
      { captureId: 'cap-1' },
      db as never,
      flowProducer as never,
      dedup,
    )

    // Terminal status check happens before dedup — dedup should not be called
    expect(dedup.isDuplicate).not.toHaveBeenCalled()
    expect(flowProducer.add).not.toHaveBeenCalled()
  })

  // SE-2 dedup — same captureId retry must pass captureId to isDuplicate
  it('passes captureId to isDuplicate so a capture retry is not self-classified as duplicate', async () => {
    const capture = makeCapture()
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()
    const dedup = makeDedup(false)

    await processIngestionJob(
      { captureId: 'cap-1' },
      db as never,
      flowProducer as never,
      dedup,
    )

    // isDuplicate must now receive captureId so the key is scoped per-capture
    expect(dedup.isDuplicate).toHaveBeenCalledWith('hash-abc-123', 'cap-1')
    expect(flowProducer.add).toHaveBeenCalled()
  })
})

// ============================================================
// SE-2 — forceRetry bypass for 'failed' captures
// ============================================================

describe('processIngestionJob — forceRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('skips a failed capture without forceRetry (existing behavior)', async () => {
    const capture = makeCapture({ pipeline_status: 'failed' })
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()

    await processIngestionJob(
      { captureId: 'cap-1' },
      db as never,
      flowProducer as never,
    )

    // Without forceRetry, failed is terminal — no pipeline work
    expect(flowProducer.add).not.toHaveBeenCalled()
  })

  it('reprocesses a failed capture when forceRetry is true', async () => {
    const capture = makeCapture({ pipeline_status: 'failed' })
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()

    await processIngestionJob(
      { captureId: 'cap-1', forceRetry: true },
      db as never,
      flowProducer as never,
    )

    // forceRetry bypasses the terminal check for 'failed' — pipeline must run
    expect(flowProducer.add).toHaveBeenCalled()
  })

  it('still treats complete as terminal even with forceRetry', async () => {
    const capture = makeCapture({ pipeline_status: 'complete' })
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()

    await processIngestionJob(
      { captureId: 'cap-1', forceRetry: true },
      db as never,
      flowProducer as never,
    )

    // 'complete' stays terminal regardless of forceRetry
    expect(flowProducer.add).not.toHaveBeenCalled()
  })

  it('still treats deleted as terminal even with forceRetry', async () => {
    const capture = makeCapture({ pipeline_status: 'deleted' })
    const db = makeDb(capture)
    const flowProducer = makeFlowProducer()

    await processIngestionJob(
      { captureId: 'cap-1', forceRetry: true },
      db as never,
      flowProducer as never,
    )

    // 'deleted' always terminal
    expect(flowProducer.add).not.toHaveBeenCalled()
  })
})
