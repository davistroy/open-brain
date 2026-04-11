import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processIngestRootJob } from '../jobs/ingest-root.js'
import type { IngestRootJobData } from '../flows/ingest-pipeline.js'

// ---------------------------------------------------------------------------
// Mock link-entities stage
// ---------------------------------------------------------------------------
const mockProcessLinkEntitiesStage = vi.fn()

vi.mock('../pipeline/stages/link-entities.js', () => ({
  processLinkEntitiesStage: (...args: unknown[]) => mockProcessLinkEntitiesStage(...args),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockDb() {
  // Minimal mock — processLinkEntitiesStage is mocked at module level
  return {} as any
}

function makeMockCheckTriggersQueue() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('processIngestRootJob', () => {
  const jobData: IngestRootJobData = { captureId: 'cap-root-1' }

  beforeEach(() => {
    vi.clearAllMocks()
    mockProcessLinkEntitiesStage.mockResolvedValue(undefined)
  })

  it('calls processLinkEntitiesStage with captureId', async () => {
    const db = makeMockDb()
    await processIngestRootJob(jobData, db)

    expect(mockProcessLinkEntitiesStage).toHaveBeenCalledWith('cap-root-1', db)
  })

  it('enqueues check-triggers job when queue is provided', async () => {
    const db = makeMockDb()
    const queue = makeMockCheckTriggersQueue()

    await processIngestRootJob(jobData, db, queue)

    expect(queue.add).toHaveBeenCalledWith(
      'check-triggers',
      { captureId: 'cap-root-1' },
      expect.objectContaining({
        jobId: expect.stringContaining('check-triggers_cap-root-1_'),
      }),
    )
  })

  it('does not throw when link-entities stage fails', async () => {
    mockProcessLinkEntitiesStage.mockRejectedValue(new Error('DB connection lost'))
    const db = makeMockDb()

    // Should complete successfully despite link-entities failure
    await expect(processIngestRootJob(jobData, db)).resolves.toBeUndefined()
  })

  it('still enqueues check-triggers after link-entities failure', async () => {
    mockProcessLinkEntitiesStage.mockRejectedValue(new Error('DB error'))
    const db = makeMockDb()
    const queue = makeMockCheckTriggersQueue()

    await processIngestRootJob(jobData, db, queue)

    expect(queue.add).toHaveBeenCalledOnce()
  })

  it('does not throw when check-triggers enqueue fails', async () => {
    const db = makeMockDb()
    const queue = makeMockCheckTriggersQueue()
    queue.add.mockRejectedValue(new Error('Redis unavailable'))

    await expect(processIngestRootJob(jobData, db, queue)).resolves.toBeUndefined()
  })

  it('completes without check-triggers queue (no queue provided)', async () => {
    const db = makeMockDb()

    await expect(processIngestRootJob(jobData, db)).resolves.toBeUndefined()
    expect(mockProcessLinkEntitiesStage).toHaveBeenCalledOnce()
  })
})
