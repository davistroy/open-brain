import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PipelineService } from '../services/pipeline.js'
import { CaptureService } from '../services/capture.js'
import { createApp } from '../app.js'
import { ConflictError, NotFoundError } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock infrastructure — same pattern as captures-routes.test.ts
// ---------------------------------------------------------------------------

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    disconnect: vi.fn(),
  })),
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
    getWaitingCount: vi.fn().mockResolvedValue(2),
    getActiveCount: vi.fn().mockResolvedValue(1),
    getCompletedCount: vi.fn().mockResolvedValue(50),
    getFailedCount: vi.fn().mockResolvedValue(3),
    getDelayedCount: vi.fn().mockResolvedValue(0),
  }
}

function makeCaptureRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-pipeline-1',
    content: 'Pipeline integration test capture',
    content_hash: 'pipelinehash',
    capture_type: 'idea',
    brain_view: 'technical',
    source: 'api',
    source_metadata: undefined,
    tags: [],
    pipeline_status: 'pending',
    pipeline_attempts: 0,
    pipeline_error: undefined,
    pipeline_completed_at: undefined,
    pre_extracted: undefined,
    created_at: new Date('2026-03-05T10:00:00Z'),
    updated_at: new Date('2026-03-05T10:00:00Z'),
    captured_at: new Date('2026-03-05T10:00:00Z'),
    ...overrides,
  }
}

function buildMockDb() {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  }
}

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  const terminal = Promise.resolve(rows)
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.groupBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockReturnValue(terminal)
  chain.offset = vi.fn().mockReturnValue(terminal)
  ;(chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal.then(resolve, reject)
  ;(chain as any).catch = (reject: (e: unknown) => void) => terminal.catch(reject)
  return chain
}

// ---------------------------------------------------------------------------
// PipelineService unit tests
// ---------------------------------------------------------------------------

describe('PipelineService', () => {
  let mockQueue: ReturnType<typeof makeMockQueue>
  let service: PipelineService

  beforeEach(() => {
    vi.clearAllMocks()
    mockQueue = makeMockQueue()
    service = new PipelineService(mockQueue as any)
  })

  describe('enqueue()', () => {
    it('adds a job to the queue with correct jobId', async () => {
      await service.enqueue('cap-123')

      expect(mockQueue.add).toHaveBeenCalledOnce()
      const [name, data, opts] = mockQueue.add.mock.calls[0]
      expect(name).toBe('capture-pipeline')
      expect(data.captureId).toBe('cap-123')
      expect(data.pipelineName).toBe('default')
      expect(opts.jobId).toBe('pipeline_cap-123')
    })

    it('uses custom pipelineName when provided', async () => {
      await service.enqueue('cap-456', 'voice')

      const [, data] = mockQueue.add.mock.calls[0]
      expect(data.pipelineName).toBe('voice')
    })

    it('uses captureId in jobId for idempotency', async () => {
      await service.enqueue('cap-789')

      const [, , opts] = mockQueue.add.mock.calls[0]
      expect(opts.jobId).toBe('pipeline_cap-789')
    })
  })

  describe('getHealth()', () => {
    it('returns queue depth counters', async () => {
      const health = await service.getHealth()

      expect(health.waiting).toBe(2)
      expect(health.active).toBe(1)
      expect(health.completed).toBe(50)
      expect(health.failed).toBe(3)
      expect(health.delayed).toBe(0)
    })

    it('returns zeros when queue throws (Redis unavailable)', async () => {
      mockQueue.getWaitingCount.mockRejectedValueOnce(new Error('Redis connection refused'))

      const health = await service.getHealth()

      expect(health.waiting).toBe(0)
      expect(health.active).toBe(0)
      expect(health.completed).toBe(0)
      expect(health.failed).toBe(0)
      expect(health.delayed).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// CaptureService + PipelineService integration
// ---------------------------------------------------------------------------

describe('CaptureService with PipelineService', () => {
  let db: ReturnType<typeof buildMockDb>
  let mockQueue: ReturnType<typeof makeMockQueue>
  let pipelineService: PipelineService
  let captureService: CaptureService

  beforeEach(() => {
    vi.clearAllMocks()
    db = buildMockDb()
    mockQueue = makeMockQueue()
    pipelineService = new PipelineService(mockQueue as any)
    captureService = new CaptureService(db as any, pipelineService)
  })

  it('enqueues a pipeline job after successful capture creation', async () => {
    const record = makeCaptureRecord()

    // Dedup check: empty
    db.select.mockReturnValueOnce(selectChain([]))

    // Insert returning the new record
    const insertChain = {
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([record]) }),
    }
    db.insert.mockReturnValueOnce(insertChain)

    const created = await captureService.create({
      content: 'Pipeline integration test capture',
      capture_type: 'idea',
      brain_view: 'technical',
      source: 'api',
    })

    expect(created.id).toBe('cap-pipeline-1')
    expect(mockQueue.add).toHaveBeenCalledOnce()
    const [, data, opts] = mockQueue.add.mock.calls[0]
    expect(data.captureId).toBe('cap-pipeline-1')
    expect(opts.jobId).toBe('pipeline_cap-pipeline-1')
  })

  it('does not fail capture creation when pipeline enqueue throws', async () => {
    const record = makeCaptureRecord()
    mockQueue.add.mockRejectedValueOnce(new Error('Redis unavailable'))

    db.select.mockReturnValueOnce(selectChain([]))
    const insertChain = {
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([record]) }),
    }
    db.insert.mockReturnValueOnce(insertChain)

    // Should not throw — pipeline failure is non-fatal for capture creation
    const created = await captureService.create({
      content: 'Should succeed even if pipeline fails',
      capture_type: 'idea',
      brain_view: 'technical',
      source: 'api',
    })

    expect(created.id).toBe('cap-pipeline-1')
  })

  it('skips pipeline enqueue when no pipelineService provided', async () => {
    // CaptureService without pipelineService
    const serviceNoPipeline = new CaptureService(db as any)
    const record = makeCaptureRecord()

    db.select.mockReturnValueOnce(selectChain([]))
    const insertChain = {
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([record]) }),
    }
    db.insert.mockReturnValueOnce(insertChain)

    const created = await serviceNoPipeline.create({
      content: 'No pipeline service attached',
      capture_type: 'idea',
      brain_view: 'technical',
      source: 'api',
    })

    expect(created.id).toBe('cap-pipeline-1')
    expect(mockQueue.add).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Retry endpoint (POST /api/v1/captures/:id/retry)
// ---------------------------------------------------------------------------

describe('POST /api/v1/captures/:id/retry', () => {
  function makeMockConfigService() {
    return {
      get: vi.fn().mockReturnValue({}),
      getBrainViews: vi.fn().mockReturnValue(['technical', 'career', 'personal', 'work-internal', 'client']),
      load: vi.fn(),
      reload: vi.fn().mockReturnValue([]),
    }
  }

  function makeMockCaptureService(record?: CaptureRecord, throwErr?: Error) {
    return {
      create: vi.fn(),
      getById: throwErr
        ? vi.fn().mockRejectedValue(throwErr)
        : vi.fn().mockResolvedValue(record ?? makeCaptureRecord()),
      list: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      getStats: vi.fn(),
    }
  }

  function makeMockPipelineService(enqueueErr?: Error) {
    return {
      enqueue: enqueueErr
        ? vi.fn().mockRejectedValue(enqueueErr)
        : vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    }
  }

  it('returns 200 with capture id and retried_at when pipeline is available', async () => {
    const record = makeCaptureRecord({ pipeline_status: 'failed' })
    const captureService = makeMockCaptureService(record)
    const pipelineService = makeMockPipelineService()
    const configService = makeMockConfigService()

    const app = createApp({
      captureService: captureService as any,
      pipelineService: pipelineService as any,
      configService: configService as any,
    })

    const res = await app.request('/api/v1/captures/cap-pipeline-1/retry', { method: 'POST' })
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(body.id).toBe('cap-pipeline-1')
    expect(body.retried_at).toBeDefined()
    expect(pipelineService.enqueue).toHaveBeenCalledWith('cap-pipeline-1', 'default', true)
  })

  it('returns 404 when capture does not exist', async () => {
    const captureService = makeMockCaptureService(undefined, new NotFoundError('Capture not found: missing-id'))
    const pipelineService = makeMockPipelineService()
    const configService = makeMockConfigService()

    const app = createApp({
      captureService: captureService as any,
      pipelineService: pipelineService as any,
      configService: configService as any,
    })

    const res = await app.request('/api/v1/captures/missing-id/retry', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 503 when pipelineService is not configured', async () => {
    const record = makeCaptureRecord()
    const captureService = makeMockCaptureService(record)
    const configService = makeMockConfigService()

    // No pipelineService passed
    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
    })

    const res = await app.request('/api/v1/captures/cap-pipeline-1/retry', { method: 'POST' })
    expect(res.status).toBe(503)
  })

  it('includes stage param in response when provided', async () => {
    const record = makeCaptureRecord({ pipeline_status: 'failed' })
    const captureService = makeMockCaptureService(record)
    const pipelineService = makeMockPipelineService()
    const configService = makeMockConfigService()

    const app = createApp({
      captureService: captureService as any,
      pipelineService: pipelineService as any,
      configService: configService as any,
    })

    const res = await app.request('/api/v1/captures/cap-pipeline-1/retry?stage=embed', { method: 'POST' })
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(body.stage).toBe('embed')
  })
})
