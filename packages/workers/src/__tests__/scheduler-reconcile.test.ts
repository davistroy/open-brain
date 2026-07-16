import { describe, it, expect, vi } from 'vitest'
import type { JobSchedulerJson } from 'bullmq'
import { reconcileRepeatableJobs } from '../scheduler.js'

/**
 * #217 — startup reconciliation of job schedulers. Fast unit coverage of the
 * BRANCHING LOGIC (which ids survive, best-effort-on-error). The real-BullMQ
 * CONTRACT (that a scheduler's key equals its id, and getRepeatableJobs never
 * populates job.id) is pinned separately in
 * integration/scheduler-repeat-identity.test.ts — because it can only be
 * verified against real Redis.
 *
 * ## Why this file was rewritten (Entry 214)
 *
 * Its previous version mocked the legacy `getRepeatableJobs()` surface and, via
 * a fixture defaulting `id: over.id ?? null`, let every case hand reconcile an
 * `id` that BullMQ v5 NEVER sets. Reconcile compared `r.jobId === job.id`, so
 * the mock's fake id made the tests pass while production deleted all 21
 * schedules on every boot for two days. A mock that supplies the field under
 * dispute cannot falsify a claim about that field. This version mocks the v5
 * Job Scheduler surface and, deliberately, never invents an `id` — a
 * scheduler's identity is its `key`.
 */

// ---------------------------------------------------------------------------
// Fixtures — model getJobSchedulers() faithfully: a live scheduler's `key` IS
// the id passed to upsertJobScheduler(); a legacy `.add({ repeat })` orphan
// surfaces under a hash `key`. We NEVER fake a field reconcile keys off of.
// ---------------------------------------------------------------------------

function scheduler(over: { key: string; name: string; pattern?: string }): JobSchedulerJson {
  return { key: over.key, name: over.name, pattern: over.pattern ?? '0 0 * * *' }
}

function mockQueue(entries: JobSchedulerJson[]) {
  const getJobSchedulers = vi.fn().mockResolvedValue(entries)
  const removeJobScheduler = vi.fn().mockResolvedValue(true)
  return { queue: { name: 'test-queue', getJobSchedulers, removeJobScheduler }, getJobSchedulers, removeJobScheduler }
}

// A representative live scheduler: key === its registered id.
const liveEntry = scheduler({ key: 'scheduled_daily-connections', name: 'daily-connections', pattern: '10 6 * * *' })
const liveRegistration = { id: 'scheduled_daily-connections', pattern: '10 6 * * *' }

describe('reconcileRepeatableJobs (#217)', () => {
  it('removes ONLY the orphan, never the freshly-registered id', async () => {
    // A renamed/removed job still scheduled from a past boot.
    const orphan = scheduler({ key: 'scheduled_retired-skill', name: 'retired-skill', pattern: '0 0 * * *' })
    const m = mockQueue([liveEntry, orphan])

    await reconcileRepeatableJobs(m.queue, [liveRegistration])

    expect(m.removeJobScheduler).toHaveBeenCalledTimes(1)
    expect(m.removeJobScheduler).toHaveBeenCalledWith('scheduled_retired-skill')
    expect(m.removeJobScheduler).not.toHaveBeenCalledWith('scheduled_daily-connections')
  })

  it('removes nothing when every scheduler id was registered', async () => {
    const second = scheduler({ key: 'scheduled_wiki-synthesis', name: 'wiki-synthesis', pattern: '0 6 * * *' })
    const m = mockQueue([liveEntry, second])

    await reconcileRepeatableJobs(m.queue, [
      liveRegistration,
      { id: 'scheduled_wiki-synthesis', pattern: '0 6 * * *' },
    ])

    expect(m.removeJobScheduler).not.toHaveBeenCalled()
  })

  it('removes a LEGACY hash-keyed orphan (pre-migration .add({ repeat }))', async () => {
    // getJobSchedulers() surfaces a legacy repeatable under a content-hash key,
    // which can never equal a registered id — so it is reconciled away.
    const legacy = scheduler({ key: '4d32e2bec56f5cbadab5e353a8040d6e', name: 'wiki-backup', pattern: '15 2 * * *' })
    const m = mockQueue([liveEntry, legacy])

    await reconcileRepeatableJobs(m.queue, [liveRegistration])

    expect(m.removeJobScheduler).toHaveBeenCalledTimes(1)
    expect(m.removeJobScheduler).toHaveBeenCalledWith('4d32e2bec56f5cbadab5e353a8040d6e')
  })

  it('is best-effort: a getJobSchedulers failure never throws or removes', async () => {
    const getJobSchedulers = vi.fn().mockRejectedValue(new Error('redis down'))
    const removeJobScheduler = vi.fn().mockResolvedValue(true)
    const queue = { name: 'test-queue', getJobSchedulers, removeJobScheduler }

    await expect(reconcileRepeatableJobs(queue, [liveRegistration])).resolves.toBeUndefined()

    expect(removeJobScheduler).not.toHaveBeenCalled()
  })

  it('continues past a removal failure (one bad scheduler must not block the rest)', async () => {
    const orphanA = scheduler({ key: 'orphan-a', name: 'a' })
    const orphanB = scheduler({ key: 'orphan-b', name: 'b' })
    const getJobSchedulers = vi.fn().mockResolvedValue([orphanA, liveEntry, orphanB])
    const removeJobScheduler = vi
      .fn()
      .mockRejectedValueOnce(new Error('remove failed'))
      .mockResolvedValue(true)
    const queue = { name: 'test-queue', getJobSchedulers, removeJobScheduler }

    await expect(reconcileRepeatableJobs(queue, [liveRegistration])).resolves.toBeUndefined()

    // Both orphans attempted despite the first throwing; the live id untouched.
    expect(removeJobScheduler).toHaveBeenCalledTimes(2)
    expect(removeJobScheduler).not.toHaveBeenCalledWith('scheduled_daily-connections')
  })
})
