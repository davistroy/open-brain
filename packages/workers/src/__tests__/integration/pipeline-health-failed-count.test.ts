/**
 * Item 3.1 — confirms against a REAL Redis that BullMQ scores the `failed` set
 * by finish time, so `ZCOUNT bull:<queue>:failed <since> +inf` (the real
 * QueueFactory's countFailedSince) counts only jobs that failed in the window.
 *
 * Requires: docker compose -f docker-compose.test.yml up -d --wait
 */
import { describe, it, expect, afterAll } from 'vitest'
import { Queue, Worker } from 'bullmq'
import { redisConnection } from './setup.js'
import { makeRealQueueFactory } from '../../skills/pipeline-health.js'

const queueName = `test-failed-count-${Date.now()}`

describe('makeRealQueueFactory — countFailedSince (real Redis)', () => {
  const queue = new Queue(queueName, { connection: redisConnection })
  let worker: Worker | undefined

  afterAll(async () => {
    await worker?.close()
    await queue.obliterate({ force: true }).catch(() => {})
    await queue.close()
  })

  it('counts only failed jobs whose finish time is inside the window', async () => {
    const w = new Worker(queueName, async (): Promise<void> => { throw new Error('boom') }, { connection: redisConnection })
    worker = w
    await w.waitUntilReady()
    const before = Date.now()
    await queue.addBulk(Array.from({ length: 3 }, (_, i) => ({ name: 'j', data: { i } })))

    const deadline = Date.now() + 15_000
    while ((await queue.getFailedCount()) < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    expect(await queue.getFailedCount()).toBe(3)

    const handle = makeRealQueueFactory(redisConnection)(queueName)
    try {
      expect(await handle.countFailedSince(before - 1000)).toBe(3)
      expect(await handle.countFailedSince(Date.now() + 60_000)).toBe(0)
    } finally {
      await handle.close()
    }
  })
})
