import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processEmbedCaptureJob } from '../jobs/embed-capture.js'
import { SpendTracker } from '../lib/spend-tracker.js'
import type { SpendCheckResult } from '../lib/spend-tracker.js'
import { DelayedError } from 'bullmq'

// ============================================================
// Mocks
// ============================================================

function makeDb(capture?: { id: string; content: string; pipeline_status: string }) {
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(capture ? [capture] : []),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue(undefined),
  }
  // Chaining: update().set().where() needs to resolve
  db.update = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) })
  return db
}

function makeEmbeddingService() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  }
}

function makeSpendTracker(result: SpendCheckResult) {
  return {
    check: vi.fn().mockResolvedValue(result),
    clearCache: vi.fn(),
  } as unknown as SpendTracker
}

// ============================================================
// Tests
// ============================================================

describe('processEmbedCaptureJob — spend-aware rate limiting', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('processes normally when spend tracker returns action=normal', async () => {
    const capture = { id: 'cap-1', content: 'Test content', pipeline_status: 'extracted' }
    const db = makeDb(capture)
    const embedService = makeEmbeddingService()
    const tracker = makeSpendTracker({ monthlySpend: 3.00, action: 'normal' })

    await processEmbedCaptureJob(
      { captureId: 'cap-1' },
      db as never,
      embedService as never,
      undefined,
      undefined,
      false,
      tracker,
    )

    // Embedding should have been called
    expect(embedService.embed).toHaveBeenCalledWith('Test content')
    expect(tracker.check).toHaveBeenCalledOnce()
  })

  it('throws DelayedError when spend tracker returns action=paused', async () => {
    const capture = { id: 'cap-1', content: 'Test content', pipeline_status: 'extracted' }
    const db = makeDb(capture)
    const embedService = makeEmbeddingService()
    const tracker = makeSpendTracker({ monthlySpend: 12.00, action: 'paused' })

    await expect(
      processEmbedCaptureJob(
        { captureId: 'cap-1' },
        db as never,
        embedService as never,
        undefined,
        undefined,
        false,
        tracker,
      ),
    ).rejects.toThrow(DelayedError)

    // Embedding should NOT have been called
    expect(embedService.embed).not.toHaveBeenCalled()
  })

  it('processes with delay when spend tracker returns action=throttled', async () => {
    const capture = { id: 'cap-1', content: 'Test content', pipeline_status: 'extracted' }
    const db = makeDb(capture)
    const embedService = makeEmbeddingService()
    const tracker = makeSpendTracker({ monthlySpend: 8.00, action: 'throttled' })

    // Mock setTimeout to verify throttle (avoid actual 30s delay in test)
    vi.useFakeTimers()

    const promise = processEmbedCaptureJob(
      { captureId: 'cap-1' },
      db as never,
      embedService as never,
      undefined,
      undefined,
      false,
      tracker,
    )

    // Advance past the throttle delay
    await vi.advanceTimersByTimeAsync(30_000)
    await promise

    vi.useRealTimers()

    // Embedding should eventually be called after throttle
    expect(embedService.embed).toHaveBeenCalledWith('Test content')
  })

  it('skips spend check when no spend tracker is provided', async () => {
    const capture = { id: 'cap-1', content: 'Test content', pipeline_status: 'extracted' }
    const db = makeDb(capture)
    const embedService = makeEmbeddingService()

    // No spendTracker — should proceed normally
    await processEmbedCaptureJob(
      { captureId: 'cap-1' },
      db as never,
      embedService as never,
      undefined,
      undefined,
      false,
      undefined, // no tracker
    )

    expect(embedService.embed).toHaveBeenCalledWith('Test content')
  })
})
