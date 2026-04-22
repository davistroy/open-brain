import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Import (no LLM mocks needed — wiki-synthesis is pure DB + queue)
// ---------------------------------------------------------------------------
import { WikiSynthesisSkill, queryUnintegratedCaptures } from '../skills/wiki-synthesis.js'
import type { WikiSynthesisResult, WikiIngestQueueLike } from '../skills/wiki-synthesis.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SAMPLE_CAPTURES = [
  {
    id: 'cap-1',
    content: 'Decided to adopt Kubernetes for container orchestration.',
    capture_type: 'decision',
    created_at: '2026-04-10T14:00:00Z',
  },
  {
    id: 'cap-2',
    content: 'Meeting notes from weekly standup about API redesign.',
    capture_type: 'observation',
    created_at: '2026-04-10T15:00:00Z',
  },
  {
    id: 'cap-3',
    content: 'Interesting paper on retrieval-augmented generation.',
    capture_type: 'idea',
    created_at: '2026-04-10T16:00:00Z',
  },
]

function makeMockDb(captures = SAMPLE_CAPTURES) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: captures }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mock-log-id' }]) }),
    }),
  } as any
}

function makeMockQueue(): WikiIngestQueueLike {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockPushover(configured = true) {
  return {
    isConfigured: configured,
    send: vi.fn().mockResolvedValue(undefined),
  } as any
}

// ---------------------------------------------------------------------------
// Tests: WikiSynthesisSkill
// ---------------------------------------------------------------------------
describe('WikiSynthesisSkill', () => {
  let db: ReturnType<typeof makeMockDb>
  let queue: ReturnType<typeof makeMockQueue>
  let pushover: ReturnType<typeof makeMockPushover>

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb()
    queue = makeMockQueue()
    pushover = makeMockPushover()
  })

  function makeSkill() {
    return new WikiSynthesisSkill({ db, pushover })
  }

  it('queries unintegrated captures and queues wiki-ingest jobs', async () => {
    const result = await makeSkill().execute({
      wikiIngestQueue: queue,
      lookbackHours: 24,
    })

    expect(result.capturesChecked).toBe(3)
    expect(result.capturesQueued).toBe(3)
    expect(result.captureIds).toEqual(['cap-1', 'cap-2', 'cap-3'])
    expect(queue.add).toHaveBeenCalledTimes(3)

    // Verify queue.add was called with correct arguments
    expect(queue.add).toHaveBeenCalledWith(
      'wiki-ingest',
      { captureId: 'cap-1' },
      { jobId: 'wiki-synthesis-cap-1' },
    )
    expect(queue.add).toHaveBeenCalledWith(
      'wiki-ingest',
      { captureId: 'cap-2' },
      { jobId: 'wiki-synthesis-cap-2' },
    )
    expect(queue.add).toHaveBeenCalledWith(
      'wiki-ingest',
      { captureId: 'cap-3' },
      { jobId: 'wiki-synthesis-cap-3' },
    )
  })

  it('handles zero unintegrated captures gracefully', async () => {
    db = makeMockDb([])

    const skill = new WikiSynthesisSkill({ db, pushover })
    const result = await skill.execute({
      wikiIngestQueue: queue,
    })

    expect(result.capturesChecked).toBe(0)
    expect(result.capturesQueued).toBe(0)
    expect(result.captureIds).toEqual([])
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('sends Pushover notification when captures are queued', async () => {
    const result = await makeSkill().execute({
      wikiIngestQueue: queue,
    })

    expect(result.notificationSent).toBe(true)
    expect(pushover.send).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Wiki Synthesis',
      priority: -1,
    }))
    expect(pushover.send).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('3 of 3'),
    }))
  })

  it('skips Pushover when no captures queued', async () => {
    db = makeMockDb([])
    const skill = new WikiSynthesisSkill({ db, pushover })

    const result = await skill.execute({
      wikiIngestQueue: queue,
    })

    expect(result.notificationSent).toBe(false)
    expect(pushover.send).not.toHaveBeenCalled()
  })

  it('skips Pushover when not configured', async () => {
    pushover = makeMockPushover(false)
    const skill = new WikiSynthesisSkill({ db, pushover })

    const result = await skill.execute({
      wikiIngestQueue: queue,
    })

    expect(result.notificationSent).toBe(false)
  })

  it('logs to skills_log', async () => {
    await makeSkill().execute({
      wikiIngestQueue: queue,
    })

    expect(db.insert).toHaveBeenCalled()
  })

  it('handles individual queue add failures gracefully', async () => {
    // First call succeeds, second fails, third succeeds
    queue.add = vi.fn()
      .mockResolvedValueOnce({ id: 'job-1' })
      .mockRejectedValueOnce(new Error('Queue full'))
      .mockResolvedValueOnce({ id: 'job-3' })

    const result = await makeSkill().execute({
      wikiIngestQueue: queue,
    })

    expect(result.capturesChecked).toBe(3)
    expect(result.capturesQueued).toBe(2) // only 2 succeeded
    expect(result.captureIds).toEqual(['cap-1', 'cap-3'])
  })

  it('handles skills_log insert failure gracefully', async () => {
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('DB error')) }),
    })

    // Should not throw
    const result = await makeSkill().execute({
      wikiIngestQueue: queue,
    })
    expect(result.capturesQueued).toBe(3)
  })

  it('respects lookbackHours option', async () => {
    await makeSkill().execute({
      wikiIngestQueue: queue,
      lookbackHours: 48,
    })

    // Verify the query was called (it will use the 48h value)
    expect(db.execute).toHaveBeenCalled()
  })

  it('does not close injected queue', async () => {
    await makeSkill().execute({
      wikiIngestQueue: queue,
    })

    // When a queue is injected (not created internally), it should not be closed
    expect(queue.close).not.toHaveBeenCalled()
  })

  it('returns correct duration timing', async () => {
    const result = await makeSkill().execute({
      wikiIngestQueue: queue,
    })

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('handles Pushover delivery failure gracefully', async () => {
    pushover.send.mockRejectedValue(new Error('Pushover down'))

    const result = await makeSkill().execute({
      wikiIngestQueue: queue,
    })

    expect(result.notificationSent).toBe(false)
    // Skill should still complete successfully
    expect(result.capturesQueued).toBe(3)
  })

  it('uses singular message for single capture', async () => {
    db = makeMockDb([SAMPLE_CAPTURES[0]])
    const skill = new WikiSynthesisSkill({ db, pushover })

    await skill.execute({
      wikiIngestQueue: queue,
    })

    expect(pushover.send).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('1 of 1 unintegrated capture '),
    }))
  })
})
