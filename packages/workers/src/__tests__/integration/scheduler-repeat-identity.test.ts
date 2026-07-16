/**
 * Scheduler ↔ BullMQ job-scheduler contract — against a REAL Redis/BullMQ.
 *
 * ## Why this test exists (a 2-day production outage — Entries 211–214)
 *
 * `reconcileRepeatableJobs` (#217) removes schedulers that were not registered
 * this boot. Its previous version matched a live entry by `name + pattern +
 * jobId` against `getRepeatableJobs()`, and registration passed `jobId` at the
 * top level of `add()`. Both relied on `job.id` — a field **BullMQ v5 never
 * populates for a repeatable**. So the identity check was always false,
 * reconciliation deleted all 21 schedules ~30ms after registering them at
 * every boot, and every scheduled job (morning-brief, wiki-synthesis,
 * pipeline-health, container-health…) silently stopped from 2026-07-14 on.
 * Manual triggers still worked, so only `WorkersMetricsAbsent` caught it — and
 * it paged, correctly, hourly for ~40 hours.
 *
 * ## Why it MUST be an integration test
 *
 * The old unit test passed and always would: it mocked `getRepeatableJobs()`
 * and let the author hand it an `id` real BullMQ never sets. The mock encoded
 * the assumption under dispute, so it was structurally incapable of falsifying
 * it — the same blind spot as `test-secrets-roundtrip.sh` (#278) and
 * `test-backup-secrets-redaction.sh` (A146). Only real BullMQ can answer what
 * real BullMQ returns. That is this file's whole job.
 *
 * The fix (option B′) migrates to the v5 Job Scheduler API: `upsertJobScheduler`
 * makes the scheduler's `key` its stable id, and reconcile keeps schedulers
 * whose key is a registered id.
 */

import { Queue } from 'bullmq'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { reconcileRepeatableJobs } from '../../scheduler.js'
import { redisConnection } from './setup.js'

const QUEUE_NAME = 'test-repeat-identity'

let queue: Queue

async function clear(): Promise<void> {
  for (const s of await queue.getJobSchedulers()) {
    await queue.removeJobScheduler(s.key).catch(() => undefined)
  }
  for (const j of await queue.getRepeatableJobs()) {
    await queue.removeRepeatableByKey(j.key).catch(() => undefined)
  }
}

beforeAll(() => {
  queue = new Queue(QUEUE_NAME, { connection: redisConnection })
})

afterEach(clear)

afterAll(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined)
  await queue.close()
})

describe('BullMQ v5 job-scheduler contract — what reconciliation depends on', () => {
  it('the OLD write path (top-level jobId) records no usable id — the exact bug', async () => {
    // How the pre-fix scheduler registered. BullMQ ignores a top-level jobId for
    // a repeatable, so getRepeatableJobs() returns an entry whose id is NOT the
    // registered jobId — which is why `r.jobId === job.id` was always false.
    const addable = queue as unknown as {
      add(n: string, d: unknown, o: { repeat: { pattern: string }; jobId: string }): Promise<unknown>
    }
    await addable.add('broken', {}, { repeat: { pattern: '0 3 * * *' }, jobId: 'broken-id' })

    const entry = (await queue.getRepeatableJobs()).find((j) => j.name === 'broken')
    expect(entry).toBeDefined()
    expect(entry?.id).not.toBe('broken-id') // it is undefined/null, never the jobId
    expect(entry?.id ?? null).toBeNull()
  })

  it('the NEW write path (upsertJobScheduler) makes key === the stable id', async () => {
    await queue.upsertJobScheduler('daily-sweep', { pattern: '0 3 * * *' }, { name: 'daily-sweep', data: {} })
    const sched = (await queue.getJobSchedulers()).find((s) => s.name === 'daily-sweep')
    expect(sched?.key).toBe('daily-sweep')
  })

  it('does NOT remove a freshly registered scheduler (regression: the 2-day outage)', async () => {
    const registered = [{ id: 'daily-sweep', pattern: '0 3 * * *' }]
    await queue.upsertJobScheduler(registered[0].id, { pattern: registered[0].pattern }, { name: 'daily-sweep', data: {} })
    expect(await queue.getJobSchedulersCount()).toBe(1)

    await reconcileRepeatableJobs(queue as never, registered)

    const survivors = await queue.getJobSchedulers()
    expect(survivors).toHaveLength(1)
    expect(survivors[0].key).toBe('daily-sweep')
  })

  it('removes a genuine orphan whose id is no longer registered', async () => {
    // A renamed/removed job still scheduled from a past boot…
    await queue.upsertJobScheduler('old-job', { pattern: '0 9 * * *' }, { name: 'old-job', data: {} })
    // …alongside one that IS registered.
    const registered = [{ id: 'daily-sweep', pattern: '0 3 * * *' }]
    await queue.upsertJobScheduler('daily-sweep', { pattern: '0 3 * * *' }, { name: 'daily-sweep', data: {} })
    expect(await queue.getJobSchedulersCount()).toBe(2)

    await reconcileRepeatableJobs(queue as never, registered)

    const survivors = await queue.getJobSchedulers()
    expect(survivors.map((s) => s.key)).toEqual(['daily-sweep'])
  })

  it('cleans a LEGACY hash-keyed orphan from the pre-migration .add({ repeat }) code', async () => {
    // The three April-2026 survivors (wiki-backup/db-backup/redis-snapshot) were
    // created this way; getJobSchedulers() sees them under a HASH key, and
    // removeJobScheduler(key) removes them uniformly.
    const addable = queue as unknown as {
      add(n: string, d: unknown, o: { repeat: { pattern: string }; jobId: string }): Promise<unknown>
    }
    await addable.add('wiki-backup', {}, { repeat: { pattern: '15 2 * * *' }, jobId: 'wiki-backup' })
    const registered = [{ id: 'daily-sweep', pattern: '0 3 * * *' }]
    await queue.upsertJobScheduler('daily-sweep', { pattern: '0 3 * * *' }, { name: 'daily-sweep', data: {} })

    // The legacy entry's scheduler key is a hash, never a registered id.
    const legacyKey = (await queue.getJobSchedulers()).find((s) => s.name === 'wiki-backup')?.key
    expect(legacyKey).toBeDefined()
    expect(legacyKey).not.toBe('wiki-backup')

    await reconcileRepeatableJobs(queue as never, registered)

    const survivors = await queue.getJobSchedulers()
    expect(survivors.map((s) => s.key)).toEqual(['daily-sweep'])
  })

  it('a changed cron on the same id REPLACES in place — no orphan to reconcile', async () => {
    await queue.upsertJobScheduler('morning-brief', { pattern: '30 2 * * *' }, { name: 'morning-brief', data: {} })
    // Re-register the same id with a new pattern, as a redeploy would.
    await queue.upsertJobScheduler('morning-brief', { pattern: '30 6 * * 1-5' }, { name: 'morning-brief', data: {} })

    const scheds = await queue.getJobSchedulers()
    expect(scheds).toHaveLength(1)
    expect(scheds[0].pattern).toBe('30 6 * * 1-5')
  })
})
