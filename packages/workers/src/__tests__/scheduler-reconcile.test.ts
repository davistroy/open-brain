import { describe, it, expect, vi } from 'vitest'
import type { RepeatableJob } from 'bullmq'
import { reconcileRepeatableJobs } from '../scheduler.js'

/**
 * PE-M3 / IA-M5 / #217 — startup reconciliation of repeatable jobs.
 *
 * Cron schedule changes leave orphaned repeatable jobs firing forever because
 * BullMQ's legacy repeat key embeds name + pattern + tz + jobId: changing the
 * pattern mints a NEW key and orphans the OLD one. reconcileRepeatableJobs()
 * runs AFTER registration and removes every repeatable whose key does not match
 * a freshly-registered (name + jobId + pattern) identity.
 *
 * The core safety invariant under test: a currently-registered (live) schedule
 * is NEVER removed — only genuine orphans are.
 */

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Build a RepeatableJob entry as getRepeatableJobs() would return it. */
function repeatable(
  over: Partial<RepeatableJob> & { key: string; name: string },
): RepeatableJob {
  return {
    key: over.key,
    name: over.name,
    id: over.id ?? null,
    endDate: over.endDate ?? null,
    tz: over.tz ?? null,
    pattern: over.pattern ?? null,
    every: over.every ?? null,
    next: over.next,
  }
}

/** Mock queue exposing only the legacy repeatable surface reconcile needs. */
function mockQueue(entries: RepeatableJob[]) {
  const getRepeatableJobs = vi.fn().mockResolvedValue(entries)
  const removeRepeatableByKey = vi.fn().mockResolvedValue(true)
  return {
    queue: { name: 'test-queue', getRepeatableJobs, removeRepeatableByKey },
    getRepeatableJobs,
    removeRepeatableByKey,
  }
}

// A representative live registration and its matching repeat-key entry.
const LIVE_KEY = 'daily-connections:scheduled_daily-connections::::10 6 * * *'
const liveEntry = repeatable({
  key: LIVE_KEY,
  name: 'daily-connections',
  id: 'scheduled_daily-connections',
  pattern: '10 6 * * *',
})
const liveRegistration = {
  name: 'daily-connections',
  jobId: 'scheduled_daily-connections',
  pattern: '10 6 * * *',
}

describe('reconcileRepeatableJobs (#217)', () => {
  it('removes ONLY the orphan, never the freshly-registered key', async () => {
    // Same name + jobId as the live job, but a STALE pattern — this is exactly
    // the #217 orphan: a past cron change that left the old repeat key behind.
    const ORPHAN_KEY = 'daily-connections:scheduled_daily-connections::::0 7 * * *'
    const orphanEntry = repeatable({
      key: ORPHAN_KEY,
      name: 'daily-connections',
      id: 'scheduled_daily-connections',
      pattern: '0 7 * * *',
    })

    const m = mockQueue([liveEntry, orphanEntry])

    await reconcileRepeatableJobs(m.queue, [liveRegistration])

    expect(m.removeRepeatableByKey).toHaveBeenCalledTimes(1)
    expect(m.removeRepeatableByKey).toHaveBeenCalledWith(ORPHAN_KEY)
    expect(m.removeRepeatableByKey).not.toHaveBeenCalledWith(LIVE_KEY)
  })

  it('removes nothing when every repeatable matches a registration', async () => {
    const secondEntry = repeatable({
      key: 'wiki-synthesis:scheduled_wiki-synthesis::::0 6 * * *',
      name: 'wiki-synthesis',
      id: 'scheduled_wiki-synthesis',
      pattern: '0 6 * * *',
    })

    const m = mockQueue([liveEntry, secondEntry])

    await reconcileRepeatableJobs(m.queue, [
      liveRegistration,
      { name: 'wiki-synthesis', jobId: 'scheduled_wiki-synthesis', pattern: '0 6 * * *' },
    ])

    expect(m.removeRepeatableByKey).not.toHaveBeenCalled()
  })

  it('removes an orphan whose name/jobId are unknown entirely', async () => {
    const ghostKey = 'retired-skill:scheduled_retired-skill::::0 0 * * *'
    const ghostEntry = repeatable({
      key: ghostKey,
      name: 'retired-skill',
      id: 'scheduled_retired-skill',
      pattern: '0 0 * * *',
    })

    const m = mockQueue([liveEntry, ghostEntry])

    await reconcileRepeatableJobs(m.queue, [liveRegistration])

    expect(m.removeRepeatableByKey).toHaveBeenCalledTimes(1)
    expect(m.removeRepeatableByKey).toHaveBeenCalledWith(ghostKey)
  })

  it('treats a tz-bearing entry as an orphan even if name/jobId/pattern match', async () => {
    // Our registrations never set a tz, so a tz-bearing repeatable cannot be
    // one of ours — it must be reconciled away.
    const tzKey = 'daily-connections:scheduled_daily-connections:::America/New_York:10 6 * * *'
    const tzEntry = repeatable({
      key: tzKey,
      name: 'daily-connections',
      id: 'scheduled_daily-connections',
      pattern: '10 6 * * *',
      tz: 'America/New_York',
    })

    const m = mockQueue([liveEntry, tzEntry])

    await reconcileRepeatableJobs(m.queue, [liveRegistration])

    expect(m.removeRepeatableByKey).toHaveBeenCalledTimes(1)
    expect(m.removeRepeatableByKey).toHaveBeenCalledWith(tzKey)
    expect(m.removeRepeatableByKey).not.toHaveBeenCalledWith(LIVE_KEY)
  })

  it('is best-effort: a getRepeatableJobs failure never throws or removes', async () => {
    const getRepeatableJobs = vi.fn().mockRejectedValue(new Error('redis down'))
    const removeRepeatableByKey = vi.fn().mockResolvedValue(true)
    const queue = { name: 'test-queue', getRepeatableJobs, removeRepeatableByKey }

    await expect(
      reconcileRepeatableJobs(queue, [liveRegistration]),
    ).resolves.toBeUndefined()

    expect(removeRepeatableByKey).not.toHaveBeenCalled()
  })
})
