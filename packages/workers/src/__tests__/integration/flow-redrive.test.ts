/**
 * Real-Redis proof of the embed re-drive (item 9.1, SE7-01 / PE-012).
 *
 * The ingest flow gives every job a FIXED id, and BullMQ returns early when a
 * job with that id exists, so a retained failed `embed_<id>` blocked every
 * later re-add. These tests run the real FlowProducer + Workers against the
 * test Redis (counting stub processors) and prove:
 *   (a) failed embed + embed-only re-drive → embed runs again (2), each
 *       enrichment processor once, root once
 *   (b) re-drive while the embed is delayed → nothing is added, `skipped`
 *   (c) failed enrichment child + embed-only re-drive → new root `completed`
 *   (d) stage 'all' → each enrichment processor runs exactly once more (2)
 *   (e) processIngestionJob itself re-drives a capture with a failed flow
 *   (f) a successful embed clears captures.pipeline_error
 *   (g) flow retention (item 9.3): `queuesOptions` prunes completed flow jobs by age
 *   (h) the production flow adds (redrive stages) carry the 7d/14d retention
 *
 * A unique BullMQ prefix keeps these queues apart from every other suite.
 *
 * Run: pnpm --filter @open-brain/workers exec vitest run \
 *        --config vitest.config.integration.ts src/__tests__/integration/flow-redrive.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FlowProducer, Queue, Worker, UnrecoverableError } from 'bullmq'
import type { ConnectionOptions, Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { captures } from '@open-brain/shared'
import type { EmbeddingService } from '@open-brain/shared'
import { buildIngestFlow, INGEST_FLOW_QUEUES_OPTIONS } from '../../flows/ingest-pipeline.js'
import { closeRedriveQueues, getFlowState, redriveCapture } from '../../flows/redrive.js'
import type { RedriveDeps } from '../../flows/redrive.js'
import { processIngestionJob } from '../../jobs/ingestion-worker.js'
import type { IngestRedrive } from '../../jobs/ingestion-worker.js'
import { processEmbedCaptureJob } from '../../jobs/embed-capture.js'
import { initTestDatabase, teardownTestDatabase, getTestDb, getTestPool, redisConnection } from './setup.js'
import { cleanDatabase, createTestCapture } from './helpers.js'

const PREFIX = `test-redrive-${randomUUID().slice(0, 8)}`
const QUEUES = ['ingest-root', 'embed-capture', 'extract-entities', 'extract-commitments', 'wiki-ingest'] as const
type QName = (typeof QUEUES)[number]

// Independent connection object so the redrive queue cache is ours alone.
const connection = { ...(redisConnection as object) } as ConnectionOptions

// ── Counting stub processors ────────────────────────────────────────────────
type Mode = 'ok' | 'fail' | 'retry'
const modes: Record<QName, Mode> = {
  'ingest-root': 'ok',
  'embed-capture': 'ok',
  'extract-entities': 'ok',
  'extract-commitments': 'ok',
  'wiki-ingest': 'ok',
}
const calls: Record<QName, Map<string, number>> = Object.fromEntries(
  QUEUES.map(q => [q, new Map<string, number>()]),
) as Record<QName, Map<string, number>>

function count(q: QName, captureId: string): number {
  return calls[q].get(captureId) ?? 0
}

let flowProducer: FlowProducer
let workers: Worker[] = []
let deps: RedriveDeps

async function waitFor(cond: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

const inspectQueues = new Map<QName, Queue>()
function inspectQueue(q: QName): Queue {
  let queue = inspectQueues.get(q)
  if (!queue) {
    queue = new Queue(q, { connection, prefix: PREFIX })
    inspectQueues.set(q, queue)
  }
  return queue
}
async function stateOf(q: QName, jobId: string): Promise<string> {
  const queue = inspectQueue(q)
  const job = await queue.getJob(jobId)
  return job ? job.getState() : 'missing'
}

async function rootState(captureId: string): Promise<string> {
  return stateOf('ingest-root', `ingest-root_${captureId}`)
}

/** Run a full first flow and wait until the root settles + enrichment ran. */
async function runFirstFlow(captureId: string, expectRoot: 'failed' | 'completed', wiki = true): Promise<void> {
  await flowProducer.add(buildIngestFlow(captureId, { includeWikiIngest: wiki }))
  await waitFor(async () => (await rootState(captureId)) === expectRoot, `root ${expectRoot}`)
  await waitFor(
    () =>
      count('extract-entities', captureId) === 1 &&
      count('extract-commitments', captureId) === 1 &&
      (!wiki || count('wiki-ingest', captureId) === 1),
    'enrichment ran once',
  )
  // Let the enrichment jobs settle (completed / failed) before the re-drive.
  await waitFor(async () => {
    for (const q of ['extract-entities', 'extract-commitments'] as const) {
      const s = await stateOf(q, `${q}_${captureId}`)
      if (s !== 'completed' && s !== 'failed') return false
    }
    return true
  }, 'enrichment settled')
}

beforeAll(async () => {
  await initTestDatabase()
  flowProducer = new FlowProducer({ connection, prefix: PREFIX })
  deps = { connection, flowProducer, prefix: PREFIX }

  for (const q of QUEUES) {
    workers.push(
      new Worker(
        q,
        async (job: Job<{ captureId: string }>) => {
          const id = job.data.captureId
          calls[q].set(id, count(q, id) + 1)
          const mode = modes[q]
          if (mode === 'fail') throw new UnrecoverableError(`${q} stub failure`)
          if (mode === 'retry') throw new Error(`${q} transient stub failure`)
        },
        {
          connection,
          prefix: PREFIX,
          concurrency: 4,
          // 'retry' mode parks the job in `delayed` for a minute (in flight).
          settings: { backoffStrategy: () => 60_000 },
        },
      ),
    )
  }
  await Promise.all(workers.map(w => w.waitUntilReady()))
})

afterAll(async () => {
  await Promise.all(workers.map(w => w.close()))
  workers = []
  for (const q of QUEUES) {
    const queue = new Queue(q, { connection, prefix: PREFIX })
    await queue.obliterate({ force: true })
    await queue.close()
  }
  await Promise.all([...inspectQueues.values()].map(q => q.close()))
  await flowProducer.close()
  await closeRedriveQueues(connection)
  await cleanDatabase()
  await teardownTestDatabase()
})

beforeEach(() => {
  for (const q of QUEUES) modes[q] = 'ok'
})

describe('redriveCapture — real Redis', () => {
  it('(a) failed embed: embed-only re-drive runs embed again, enrichment and root once', async () => {
    const captureId = randomUUID()
    modes['embed-capture'] = 'fail'
    await runFirstFlow(captureId, 'failed')
    expect(await stateOf('embed-capture', `embed_${captureId}`)).toBe('failed')
    expect(await getFlowState(connection, captureId, PREFIX)).toBe('finished')

    // The pre-fix behaviour: a plain re-add is swallowed by the fixed job ids.
    await flowProducer.add(buildIngestFlow(captureId, { includeWikiIngest: true }))
    await new Promise(r => setTimeout(r, 300))
    expect(count('embed-capture', captureId)).toBe(1)

    modes['embed-capture'] = 'ok'
    const result = await redriveCapture(deps, captureId, { stage: 'embed', includeWikiIngest: true })
    expect(result).toEqual({
      action: 'redriven',
      stage: 'embed',
      removed: [`ingest-root_${captureId}`, `embed_${captureId}`],
    })

    await waitFor(async () => (await rootState(captureId)) === 'completed', 'new root completed')
    expect(count('embed-capture', captureId)).toBe(2)
    expect(count('extract-entities', captureId)).toBe(1)
    expect(count('extract-commitments', captureId)).toBe(1)
    expect(count('wiki-ingest', captureId)).toBe(1)
    expect(count('ingest-root', captureId)).toBe(1)
  })

  it('(b) embed delayed (in flight): re-drive adds nothing and returns skipped', async () => {
    const captureId = randomUUID()
    modes['embed-capture'] = 'retry'
    await flowProducer.add(buildIngestFlow(captureId))
    await waitFor(
      async () => (await stateOf('embed-capture', `embed_${captureId}`)) === 'delayed',
      'embed delayed',
    )
    const embedQueue = new Queue('embed-capture', { connection, prefix: PREFIX })
    const before = await embedQueue.getJob(`embed_${captureId}`)

    expect(await getFlowState(connection, captureId, PREFIX)).toBe('in-flight')
    const result = await redriveCapture(deps, captureId, { stage: 'embed', includeWikiIngest: false })
    expect(result).toEqual({ action: 'skipped', reason: 'in-flight' })

    const after = await embedQueue.getJob(`embed_${captureId}`)
    expect(after?.timestamp).toBe(before?.timestamp)
    expect(await stateOf('embed-capture', `embed_${captureId}`)).toBe('delayed')
    expect(await rootState(captureId)).toBe('waiting-children')
    expect(count('embed-capture', captureId)).toBe(1)
    expect(await embedQueue.getJobCounts('waiting', 'active')).toMatchObject({ waiting: 0, active: 0 })
    await embedQueue.close()
  })

  it('(c) failed enrichment child + embed-only re-drive: the new root reaches completed', async () => {
    const captureId = randomUUID()
    modes['embed-capture'] = 'fail'
    modes['extract-entities'] = 'fail'
    await runFirstFlow(captureId, 'failed', false)
    expect(await stateOf('extract-entities', `extract-entities_${captureId}`)).toBe('failed')

    modes['embed-capture'] = 'ok'
    modes['extract-entities'] = 'ok'
    await redriveCapture(deps, captureId, { stage: 'embed', includeWikiIngest: false })

    await waitFor(async () => (await rootState(captureId)) === 'completed', 'new root completed')
    expect(count('extract-entities', captureId)).toBe(1)
    // The failed child stays retained — its fixed id still guards the enrichment.
    expect(await stateOf('extract-entities', `extract-entities_${captureId}`)).toBe('failed')
  })

  it("(d) stage 'all': each finished enrichment child is removed by id and runs exactly once more", async () => {
    const captureId = randomUUID()
    await runFirstFlow(captureId, 'completed')

    const result = await redriveCapture(deps, captureId, { stage: 'all', includeWikiIngest: true })
    expect(result).toMatchObject({ action: 'redriven', stage: 'all' })
    expect(result.action === 'redriven' && result.removed.sort()).toEqual(
      [
        `embed_${captureId}`,
        `extract-commitments_${captureId}`,
        `extract-entities_${captureId}`,
        `ingest-root_${captureId}`,
        `wiki-ingest_${captureId}`,
      ].sort(),
    )

    await waitFor(() => count('ingest-root', captureId) === 2, 'second root run')
    await waitFor(async () => (await rootState(captureId)) === 'completed', 'new root completed')
    expect(count('embed-capture', captureId)).toBe(2)
    expect(count('extract-entities', captureId)).toBe(2)
    expect(count('extract-commitments', captureId)).toBe(2)
    expect(count('wiki-ingest', captureId)).toBe(2)
  })

  it("(d2) stage 'all' with only an enrichment child in flight: skipped, nothing removed", async () => {
    const captureId = randomUUID()
    await runFirstFlow(captureId, 'completed', false)
    // Root + embed are finished; put a delayed (in-flight) commitments job in place.
    const commitments = new Queue('extract-commitments', { connection, prefix: PREFIX })
    await commitments.remove(`extract-commitments_${captureId}`)
    await commitments.add('extract-commitments', { captureId }, { jobId: `extract-commitments_${captureId}`, delay: 60_000 })
    expect(await getFlowState(connection, captureId, PREFIX)).toBe('finished')

    const result = await redriveCapture(deps, captureId, { stage: 'all', includeWikiIngest: false })
    expect(result).toEqual({ action: 'skipped', reason: 'in-flight' })
    expect(await rootState(captureId)).toBe('completed')
    expect(await stateOf('embed-capture', `embed_${captureId}`)).toBe('completed')
    expect(count('extract-entities', captureId)).toBe(1)
    await commitments.close()
  })
})

describe('processIngestionJob — re-drive wiring against real Redis + Postgres', () => {
  beforeEach(async () => {
    await cleanDatabase()
  })

  function hooks(): IngestRedrive {
    return {
      getFlowState: id => getFlowState(connection, id, PREFIX),
      redriveCapture: (id, opts) => redriveCapture(deps, id, opts),
    }
  }

  it('(e) a later capture-pipeline job re-drives a capture whose embed failed', async () => {
    const capture = await createTestCapture({ pipeline_status: 'pending' })
    const captureId = capture.id as string
    const db = getTestDb()

    // First run: no retained flow → the full flow is added as before.
    modes['embed-capture'] = 'fail'
    await processIngestionJob({ captureId }, db, flowProducer, undefined, hooks())
    await waitFor(async () => (await rootState(captureId)) === 'failed', 'root failed')
    await waitFor(
      () => count('extract-entities', captureId) === 1 && count('extract-commitments', captureId) === 1,
      'enrichment ran',
    )

    // Second run (the sweep / retry): the retained failed flow is re-driven.
    modes['embed-capture'] = 'ok'
    await processIngestionJob({ captureId }, db, flowProducer, undefined, hooks())
    await waitFor(async () => (await rootState(captureId)) === 'completed', 'new root completed')

    expect(count('embed-capture', captureId)).toBe(2)
    expect(count('extract-entities', captureId)).toBe(1)
    expect(count('extract-commitments', captureId)).toBe(1)
    const [row] = await db.select().from(captures).where(eq(captures.id, captureId))
    expect(row.pipeline_status).toBe('extracted')
  })

  it('(f) a successful embed sets pipeline_error to NULL', async () => {
    const capture = await createTestCapture({ pipeline_status: 'extracted' })
    const captureId = capture.id as string
    await getTestPool().query(`UPDATE captures SET pipeline_error = 'embed failed earlier' WHERE id = $1`, [captureId])

    const embeddingService = {
      embed: async () => Array.from({ length: 768 }, () => 0.01),
    } as unknown as EmbeddingService
    await processEmbedCaptureJob(
      { data: { captureId } } as Job<{ captureId: string }>,
      undefined,
      getTestDb(),
      embeddingService,
    )

    const { rows } = await getTestPool().query(
      'SELECT pipeline_status, pipeline_error FROM captures WHERE id = $1',
      [captureId],
    )
    expect(rows[0]).toEqual({ pipeline_status: 'complete', pipeline_error: null })
  })
})

// ── Item 9.3: flow-job retention ─────────────────────────────────────────────
// FlowProducer.add ignores Queue defaultJobOptions; retention comes only from
// the `queuesOptions` argument. These cases use their own capture ids, so they
// do not interact with (a)-(f) beyond sharing the stub workers.
describe('flow job retention — real Redis (item 9.3)', () => {
  // The production map with the completed-job age shortened to 1 second.
  const ONE_SECOND_RETENTION = Object.fromEntries(
    Object.entries(INGEST_FLOW_QUEUES_OPTIONS).map(([q, o]) => [
      q,
      { defaultJobOptions: { ...o!.defaultJobOptions, removeOnComplete: { age: 1 } } },
    ]),
  )

  it('(g) with queuesOptions, a completed embed job older than the age is pruned when another job completes', async () => {
    const first = randomUUID()
    const second = randomUUID()
    await flowProducer.add(buildIngestFlow(first), { queuesOptions: ONE_SECOND_RETENTION })
    await waitFor(async () => (await stateOf('embed-capture', `embed_${first}`)) === 'completed', 'first embed completed')
    const completedKey = `${PREFIX}:embed-capture:completed`
    const redis = await inspectQueue('embed-capture').client
    expect(await redis.zscore(completedKey, `embed_${first}`)).not.toBeNull()

    await new Promise(r => setTimeout(r, 1_500)) // past the 1 s age

    // BullMQ prunes on the NEXT completion in that queue.
    await flowProducer.add(buildIngestFlow(second), { queuesOptions: ONE_SECOND_RETENTION })
    await waitFor(async () => (await stateOf('embed-capture', `embed_${second}`)) === 'completed', 'second embed completed')

    await waitFor(async () => (await redis.zscore(completedKey, `embed_${first}`)) === null, 'first embed pruned')
    expect(await stateOf('embed-capture', `embed_${first}`)).toBe('missing')
  })

  it('(h) redriveCapture adds flows whose jobs carry removeOnComplete 7d / removeOnFail 14d (every stage)', async () => {
    for (const stage of ['embed', 'all'] as const) {
      const captureId = randomUUID()
      const result = await redriveCapture(deps, captureId, { stage, includeWikiIngest: true })
      expect(result.action).toBe('redriven')
      await waitFor(async () => (await rootState(captureId)) === 'completed', `${stage} root completed`)
      const queuesChecked: QName[] =
        stage === 'embed' ? ['ingest-root', 'embed-capture'] : [...QUEUES]
      for (const q of queuesChecked) {
        const id = q === 'ingest-root' ? `ingest-root_${captureId}` : `${q === 'embed-capture' ? 'embed' : q}_${captureId}`
        const job = await inspectQueue(q).getJob(id)
        expect(job?.opts.removeOnComplete, `${stage}/${q}`).toEqual({ age: 604_800 })
        expect(job?.opts.removeOnFail, `${stage}/${q}`).toEqual({ age: 1_209_600 })
      }
    }
  })
})
