/**
 * Pipeline Smoke Tests (6.3) -- BullMQ flow, retry, and idempotency.
 *
 * Exercises the real BullMQ capture pipeline with real Redis and Postgres.
 * LLM and embedding calls are stubbed (LiteLLM unavailable in test/CI).
 * FlowProducer is mocked for ingestion tests (real flow orchestration
 * tested via the ingest-pipeline unit tests).
 *
 * Requires docker-compose.test.yml services running:
 *   docker compose -f docker-compose.test.yml up -d
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Queue, Worker } from 'bullmq'
import { eq } from 'drizzle-orm'
import { captures, pipeline_events } from '@open-brain/shared'
import {
  initTestDatabase,
  teardownTestDatabase,
  getTestDb,
  redisConnection,
} from './setup.js'
import { cleanDatabase, createTestCapture } from './helpers.js'
import {
  processIngestionJob,
  pipelineBackoffStrategy,
} from '../../jobs/ingestion-worker.js'
import { processEmbedCaptureJob } from '../../jobs/embed-capture.js'
import type { CapturePipelineJobData } from '../../queues/capture-pipeline.js'
import type { EmbedCaptureJobData } from '../../queues/embed-capture.js'

// ---------------------------------------------------------------------------
// Queue name generator -- unique per test to avoid cross-test collision
// ---------------------------------------------------------------------------

let testRunId = 0

function uniqueQueueName(base: string): string {
  return `test-${base}-${testRunId++}-${Date.now()}`
}

/**
 * Create a mock FlowProducer for tests.
 * Ingestion worker calls flowProducer.add() to enqueue the DAG.
 */
function mockFlowProducer() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Suite lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await cleanDatabase()
})

// ---------------------------------------------------------------------------
// Helper: wait for a BullMQ job to reach a terminal state
// ---------------------------------------------------------------------------

async function waitForJobState(
  queue: Queue,
  jobId: string,
  targetStates: string[],
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const job = await queue.getJob(jobId)
    if (job) {
      const state = await job.getState()
      if (targetStates.includes(state)) return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Job ${jobId} did not reach ${targetStates.join('|')} within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// 1. Pipeline flow: capture -> ingestion job -> flow DAG enqueued -> embed -> complete
// ---------------------------------------------------------------------------

describe('Pipeline Flow', () => {
  it('processes a capture through ingestion stage and enqueues FlowProducer DAG', async () => {
    const db = getTestDb()
    const flowProducer = mockFlowProducer()

    // Create a test capture in 'pending' state
    const capture = await createTestCapture({
      content: 'Pipeline flow test capture -- should transit to extracted',
      pipeline_status: 'pending',
    })
    const captureId = capture.id as string

    // Process ingestion job -- calls flowProducer.add() to enqueue DAG
    await processIngestionJob({ captureId }, db, flowProducer as any)

    // Verify capture status -> 'extracted'
    const [afterIngestion] = await db
      .select({
        pipeline_status: captures.pipeline_status,
        pipeline_attempts: captures.pipeline_attempts,
      })
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1)

    expect(afterIngestion.pipeline_status).toBe('extracted')
    expect(afterIngestion.pipeline_attempts).toBe(1)

    // Verify pipeline_events recorded for extract stage
    const extractEvents = await db
      .select()
      .from(pipeline_events)
      .where(eq(pipeline_events.capture_id, captureId))

    const extractStarted = extractEvents.find(
      (e) => e.stage === 'extract' && e.status === 'started',
    )
    const extractSuccess = extractEvents.find(
      (e) => e.stage === 'extract' && e.status === 'success',
    )
    expect(extractStarted).toBeDefined()
    expect(extractSuccess).toBeDefined()

    // Verify FlowProducer.add was called with the correct DAG
    expect(flowProducer.add).toHaveBeenCalledOnce()
    const flowArg = flowProducer.add.mock.calls[0][0]
    expect(flowArg.name).toBe('ingest-root')
    expect(flowArg.data.captureId).toBe(captureId)
    expect(flowArg.children).toHaveLength(2)
    const childQueues = flowArg.children.map((c: any) => c.queueName).sort()
    expect(childQueues).toEqual(['embed-capture', 'extract-entities'])
  })

  it('processes embed stage independently and advances to complete', async () => {
    const db = getTestDb()

    // Stub embedding service -- returns zero vectors (768d)
    const stubEmbeddingService = {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      embedBatch: vi.fn(),
    }

    // Create a test capture in 'extracted' state (as if ingestion already ran)
    const capture = await createTestCapture({
      content: 'Embed stage test capture -- should transit to complete',
      pipeline_status: 'extracted',
    })
    const captureId = capture.id as string

    // Process embed job directly
    await processEmbedCaptureJob(
      { captureId },
      db,
      stubEmbeddingService as any,
    )

    // Verify capture status -> 'complete'
    const [afterEmbed] = await db
      .select({
        pipeline_status: captures.pipeline_status,
        pipeline_completed_at: captures.pipeline_completed_at,
      })
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1)

    expect(afterEmbed.pipeline_status).toBe('complete')
    expect(afterEmbed.pipeline_completed_at).toBeDefined()
    expect(afterEmbed.pipeline_completed_at).toBeInstanceOf(Date)

    // Verify embed pipeline_events
    const allEvents = await db
      .select()
      .from(pipeline_events)
      .where(eq(pipeline_events.capture_id, captureId))

    const embedStarted = allEvents.find((e) => e.stage === 'embed' && e.status === 'started')
    const embedSuccess = allEvents.find((e) => e.stage === 'embed' && e.status === 'success')
    expect(embedStarted).toBeDefined()
    expect(embedSuccess).toBeDefined()

    // Verify embedding service was called with capture content
    expect(stubEmbeddingService.embed).toHaveBeenCalledWith(
      'Embed stage test capture -- should transit to complete',
    )
  })

  it('processes ingestion via BullMQ worker with real Redis', async () => {
    const db = getTestDb()
    const flowProducer = mockFlowProducer()

    const pipelineQueueName = uniqueQueueName('capture-pipeline')
    const pipelineQueue = new Queue<CapturePipelineJobData>(pipelineQueueName, {
      connection: redisConnection,
    })

    // Create a test capture
    const capture = await createTestCapture({
      content: 'E2E worker test capture',
      pipeline_status: 'pending',
    })
    const captureId = capture.id as string

    // Create ingestion worker with mock FlowProducer
    const ingestionWorker = new Worker<CapturePipelineJobData>(
      pipelineQueueName,
      async (job) => {
        await processIngestionJob(job.data, db, flowProducer as any)
      },
      {
        connection: redisConnection,
        settings: { backoffStrategy: pipelineBackoffStrategy },
      },
    )

    // Enqueue the pipeline job
    await pipelineQueue.add('ingest', { captureId }, { jobId: captureId })

    // Wait for the pipeline job to complete
    await waitForJobState(pipelineQueue, captureId, ['completed'])

    // Verify FlowProducer.add was called (DAG enqueued)
    expect(flowProducer.add).toHaveBeenCalled()

    // Verify final capture state (extracted -- embed hasn't run yet)
    const [final] = await db
      .select({
        pipeline_status: captures.pipeline_status,
      })
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1)

    expect(final.pipeline_status).toBe('extracted')

    // Cleanup
    await ingestionWorker.close()
    await pipelineQueue.obliterate({ force: true })
    await pipelineQueue.close()
  })

  it('skips already-terminal captures (idempotency guard in ingestion)', async () => {
    const db = getTestDb()
    const flowProducer = mockFlowProducer()

    // Create a capture that is already 'complete'
    const capture = await createTestCapture({
      content: 'Already complete capture',
      pipeline_status: 'complete',
    })
    const captureId = capture.id as string

    // Process ingestion -- should skip without side effects
    await processIngestionJob({ captureId }, db, flowProducer as any)

    // Verify no flow DAG was enqueued
    expect(flowProducer.add).not.toHaveBeenCalled()

    // Verify pipeline_events are empty (no stage processing happened)
    const events = await db
      .select()
      .from(pipeline_events)
      .where(eq(pipeline_events.capture_id, captureId))

    expect(events).toHaveLength(0)
  })

  it('skips already-embedded captures in embed worker (idempotency guard)', async () => {
    const db = getTestDb()

    const stubEmbeddingService = {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0)),
      embedBatch: vi.fn(),
    }

    // Create a capture already at 'complete' status
    const capture = await createTestCapture({
      content: 'Already embedded capture',
      pipeline_status: 'complete',
    })
    const captureId = capture.id as string

    // Process embed -- should skip
    await processEmbedCaptureJob(
      { captureId },
      db,
      stubEmbeddingService as any,
    )

    // Embedding service should NOT have been called
    expect(stubEmbeddingService.embed).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2. Retry behavior: backoff strategy + stage failure -> BullMQ retry
// ---------------------------------------------------------------------------

describe('Retry Behavior', () => {
  it('pipelineBackoffStrategy returns correct patient delays', () => {
    // Attempt 1 -> 30s
    expect(pipelineBackoffStrategy(1)).toBe(30_000)
    // Attempt 2 -> 2m
    expect(pipelineBackoffStrategy(2)).toBe(120_000)
    // Attempt 3 -> 10m
    expect(pipelineBackoffStrategy(3)).toBe(600_000)
    // Attempt 4 -> 30m
    expect(pipelineBackoffStrategy(4)).toBe(1_800_000)
    // Attempt 5 -> 2h
    expect(pipelineBackoffStrategy(5)).toBe(7_200_000)
    // Beyond max -> clamp to last delay
    expect(pipelineBackoffStrategy(10)).toBe(7_200_000)
  })

  it('retries embed job on embedding failure via BullMQ with real Redis', async () => {
    const db = getTestDb()

    const embedQueueName = uniqueQueueName('embed-capture')
    const embedQueue = new Queue<EmbedCaptureJobData>(embedQueueName, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 100 }, // fast retry for tests
      },
    })

    let callCount = 0
    const failThenSucceedEmbedding = {
      embed: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount <= 2) {
          throw new Error(`Embedding unavailable (call ${callCount})`)
        }
        return new Array(768).fill(0.2)
      }),
      embedBatch: vi.fn(),
    }

    // Create capture in 'extracted' status (ready for embedding)
    const capture = await createTestCapture({
      content: 'Retry test capture',
      pipeline_status: 'extracted',
    })
    const captureId = capture.id as string

    // Create embed worker that processes jobs from real Redis
    const embedWorker = new Worker<EmbedCaptureJobData>(
      embedQueueName,
      async (job) => {
        await processEmbedCaptureJob(
          job.data,
          db,
          failThenSucceedEmbedding as any,
        )
      },
      {
        connection: redisConnection,
      },
    )

    // Enqueue embed job
    const jobId = `embed_${captureId}`
    await embedQueue.add('embed', { captureId }, { jobId })

    // Wait for job to complete (after retries)
    await waitForJobState(embedQueue, jobId, ['completed'], 30_000)

    // Embedding service should have been called 3 times (2 failures + 1 success)
    expect(failThenSucceedEmbedding.embed).toHaveBeenCalledTimes(3)

    // Capture should be 'complete' after successful retry
    const [final] = await db
      .select({ pipeline_status: captures.pipeline_status })
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1)

    expect(final.pipeline_status).toBe('complete')

    // Verify failure events were recorded in pipeline_events
    const events = await db
      .select()
      .from(pipeline_events)
      .where(eq(pipeline_events.capture_id, captureId))

    const failedEvents = events.filter(
      (e) => e.stage === 'embed' && e.status === 'failed',
    )
    expect(failedEvents.length).toBe(2)

    // Verify each failure has an error message
    for (const fe of failedEvents) {
      expect(fe.error).toMatch(/Embedding unavailable/)
    }

    // Cleanup
    await embedWorker.close()
    await embedQueue.obliterate({ force: true })
    await embedQueue.close()
  })

  it('records pipeline_error on embed failure', async () => {
    const db = getTestDb()

    const failingEmbeddingService = {
      embed: vi.fn().mockRejectedValue(new Error('LiteLLM down')),
      embedBatch: vi.fn(),
    }

    const capture = await createTestCapture({
      content: 'Error capture test',
      pipeline_status: 'extracted',
    })
    const captureId = capture.id as string

    // Process directly -- expect throw
    await expect(
      processEmbedCaptureJob(
        { captureId },
        db,
        failingEmbeddingService as any,
      ),
    ).rejects.toThrow('LiteLLM down')

    // Verify pipeline_error is set on the capture
    const [updated] = await db
      .select({
        pipeline_error: captures.pipeline_error,
        pipeline_status: captures.pipeline_status,
      })
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1)

    expect(updated.pipeline_error).toBe('LiteLLM down')
    // Status should still be 'extracted' -- not advanced
    expect(updated.pipeline_status).toBe('extracted')
  })

  it('throws UnrecoverableError for missing captures (no retry)', async () => {
    const db = getTestDb()
    const flowProducer = mockFlowProducer()

    const nonExistentId = '00000000-0000-0000-0000-000000000000'

    await expect(
      processIngestionJob({ captureId: nonExistentId }, db, flowProducer as any),
    ).rejects.toThrow(/not found/)
  })
})

// ---------------------------------------------------------------------------
// 3. Idempotency: duplicate processing guard
// ---------------------------------------------------------------------------

describe('Idempotency', () => {
  it('FlowProducer deduplicates via idempotent jobIds in flow DAG', async () => {
    const db = getTestDb()
    const flowProducer = mockFlowProducer()

    const capture = await createTestCapture({
      content: 'Idempotency test capture',
      pipeline_status: 'pending',
    })
    const captureId = capture.id as string

    // Run ingestion once -- enqueues flow DAG
    await processIngestionJob({ captureId }, db, flowProducer as any)

    // Run ingestion again (capture is now 'extracted', not terminal)
    await processIngestionJob({ captureId }, db, flowProducer as any)

    // FlowProducer.add was called twice, but each flow DAG uses
    // idempotent jobIds (embed_{captureId}, extract-entities_{captureId})
    // so BullMQ deduplicates at the queue level
    expect(flowProducer.add).toHaveBeenCalledTimes(2)

    // Verify both calls use the same idempotent jobIds
    const call1 = flowProducer.add.mock.calls[0][0]
    const call2 = flowProducer.add.mock.calls[1][0]
    expect(call1.opts.jobId).toBe(call2.opts.jobId)
  })

  it('embed worker does not re-embed a capture already at complete status', async () => {
    const db = getTestDb()

    const stubEmbeddingService = {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      embedBatch: vi.fn(),
    }

    // Create capture already complete with an embedding
    const capture = await createTestCapture({
      content: 'Already complete with embedding',
      pipeline_status: 'complete',
      embedding: new Array(768).fill(0.5),
    })
    const captureId = capture.id as string

    // Process embed -- should skip (idempotency guard)
    await processEmbedCaptureJob(
      { captureId },
      db,
      stubEmbeddingService as any,
    )

    // Embedding service should NOT have been called
    expect(stubEmbeddingService.embed).not.toHaveBeenCalled()

    // No pipeline_events should have been created
    const events = await db
      .select()
      .from(pipeline_events)
      .where(eq(pipeline_events.capture_id, captureId))

    expect(events).toHaveLength(0)
  })

  it('ingestion + embed processes a capture exactly once to completion', async () => {
    const db = getTestDb()
    const flowProducer = mockFlowProducer()

    const stubEmbeddingService = {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.3)),
      embedBatch: vi.fn(),
    }

    const capture = await createTestCapture({
      content: 'Full idempotency test',
      pipeline_status: 'pending',
    })
    const captureId = capture.id as string

    // Step 1: Run ingestion (enqueues flow DAG via mock)
    await processIngestionJob({ captureId }, db, flowProducer as any)
    expect(flowProducer.add).toHaveBeenCalledOnce()

    // Step 2: Run embed (simulating what the flow DAG child would do)
    await processEmbedCaptureJob({ captureId }, db, stubEmbeddingService as any)

    // Verify final state
    const [final] = await db
      .select({ pipeline_status: captures.pipeline_status })
      .from(captures)
      .where(eq(captures.id, captureId))
      .limit(1)

    expect(final.pipeline_status).toBe('complete')

    // Embedding should have been called exactly once
    expect(stubEmbeddingService.embed).toHaveBeenCalledTimes(1)

    // Step 3: Run ingestion again -- should skip (already complete)
    await processIngestionJob({ captureId }, db, flowProducer as any)

    // FlowProducer should NOT have been called again (terminal guard)
    expect(flowProducer.add).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// 4. Queue cleanup: verify test isolation mechanism works
// ---------------------------------------------------------------------------

describe('Queue Cleanup', () => {
  it('obliterate removes all jobs from a queue', async () => {
    const queueName = uniqueQueueName('cleanup-test')
    const queue = new Queue(queueName, { connection: redisConnection })

    // Add some jobs
    await queue.add('job1', { data: 1 })
    await queue.add('job2', { data: 2 })
    await queue.add('job3', { data: 3 })

    const beforeCount = await queue.getJobCounts()
    expect(beforeCount.waiting).toBe(3)

    // Obliterate
    await queue.obliterate({ force: true })

    const afterCount = await queue.getJobCounts()
    expect(afterCount.waiting).toBe(0)

    await queue.close()
  })
})
