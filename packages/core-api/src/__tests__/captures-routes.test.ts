import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import { ConflictError, NotFoundError } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock infrastructure dependencies so createApp() can import routes cleanly
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
// Shared test fixture
// ---------------------------------------------------------------------------

function makeCaptureRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'cap-abc-123',
    content: 'Interesting idea about distributed systems',
    content_hash: 'hash123',
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

// ---------------------------------------------------------------------------
// Mock service factories
// ---------------------------------------------------------------------------

function makeMockCaptureService(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    getStats: vi.fn(),
    ...overrides,
  }
}

function makeMockConfigService(views = ['technical', 'career', 'personal', 'work-internal', 'client']) {
  return {
    getBrainViews: vi.fn().mockReturnValue(views),
    get: vi.fn(),
    load: vi.fn(),
    reload: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/captures
// ---------------------------------------------------------------------------

describe('POST /api/v1/captures', () => {
  let captureService: ReturnType<typeof makeMockCaptureService>
  let configService: ReturnType<typeof makeMockConfigService>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeMockCaptureService()
    configService = makeMockConfigService()
  })

  it('returns 201 with id, pipeline_status, and created_at on valid input', async () => {
    const record = makeCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Interesting idea about distributed systems',
        capture_type: 'idea',
        brain_view: 'technical',
        source: 'api',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe('cap-abc-123')
    expect(body.pipeline_status).toBe('pending')
    expect(body.created_at).toBeTruthy()
  })

  it('returns 400 when content is missing', async () => {
    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_type: 'idea',
        brain_view: 'technical',
      }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when capture_type is invalid', async () => {
    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Some content',
        capture_type: 'not-a-valid-type',
        brain_view: 'technical',
      }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when brain_view is not in configured views', async () => {
    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Some content',
        capture_type: 'idea',
        brain_view: 'not-a-real-view',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 409 on duplicate capture within 60s', async () => {
    captureService.create.mockRejectedValueOnce(
      new ConflictError('Duplicate capture detected within the last 60 seconds (id: cap-existing)'),
    )

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Duplicate content',
        capture_type: 'idea',
        brain_view: 'technical',
      }),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('CONFLICT')
  })

  it('passes metadata through to captureService.create', async () => {
    const record = makeCaptureRecord({ tags: ['ml', 'systems'] })
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    await app.request('/api/v1/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Tagged capture',
        capture_type: 'idea',
        brain_view: 'technical',
        metadata: { tags: ['ml', 'systems'] },
      }),
    })

    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ tags: ['ml', 'systems'] }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/captures — list
// ---------------------------------------------------------------------------

describe('GET /api/v1/captures', () => {
  let captureService: ReturnType<typeof makeMockCaptureService>
  let configService: ReturnType<typeof makeMockConfigService>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeMockCaptureService()
    configService = makeMockConfigService()
  })

  it('returns 200 with items, total, limit, offset', async () => {
    const records = [makeCaptureRecord(), makeCaptureRecord({ id: 'cap-2' })]
    captureService.list.mockResolvedValueOnce({ items: records, total: 2 })

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.limit).toBe(20)
    expect(body.offset).toBe(0)
  })

  it('forwards pagination query params', async () => {
    captureService.list.mockResolvedValueOnce({ items: [], total: 50 })

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures?limit=10&offset=30')

    expect(res.status).toBe(200)
    expect(captureService.list).toHaveBeenCalledWith(
      expect.any(Object),
      10,
      30,
    )
  })

  it('forwards brain_view filter', async () => {
    captureService.list.mockResolvedValueOnce({ items: [], total: 0 })

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    await app.request('/api/v1/captures?brain_view=career')

    expect(captureService.list).toHaveBeenCalledWith(
      expect.objectContaining({ brain_view: 'career' }),
      expect.any(Number),
      expect.any(Number),
    )
  })

  it('forwards capture_type filter', async () => {
    captureService.list.mockResolvedValueOnce({ items: [], total: 0 })

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    await app.request('/api/v1/captures?capture_type=task')

    expect(captureService.list).toHaveBeenCalledWith(
      expect.objectContaining({ capture_type: 'task' }),
      expect.any(Number),
      expect.any(Number),
    )
  })

  it('returns 400 for invalid limit', async () => {
    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures?limit=999')

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/captures/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/captures/:id', () => {
  let captureService: ReturnType<typeof makeMockCaptureService>
  let configService: ReturnType<typeof makeMockConfigService>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeMockCaptureService()
    configService = makeMockConfigService()
  })

  it('returns 200 with the capture record', async () => {
    const record = makeCaptureRecord()
    captureService.getById.mockResolvedValueOnce(record)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/cap-abc-123')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('cap-abc-123')
  })

  it('returns 404 when capture does not exist', async () => {
    captureService.getById.mockRejectedValueOnce(new NotFoundError('Capture not found: missing-id'))

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/missing-id')

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/captures/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/captures/:id', () => {
  let captureService: ReturnType<typeof makeMockCaptureService>
  let configService: ReturnType<typeof makeMockConfigService>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeMockCaptureService()
    configService = makeMockConfigService()
  })

  it('returns 200 with the updated record', async () => {
    const updated = makeCaptureRecord({ tags: ['updated'], brain_view: 'career' })
    captureService.update.mockResolvedValueOnce(updated)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/cap-abc-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['updated'], brain_view: 'career' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tags).toEqual(['updated'])
  })

  it('returns 404 when capture does not exist', async () => {
    captureService.update.mockRejectedValueOnce(new NotFoundError('Capture not found: missing-id'))

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/missing-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['test'] }),
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
  })

  it('returns 400 when brain_view is not in configured views', async () => {
    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/cap-abc-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain_view: 'not-valid-view' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 with empty tags array still valid (no content requirement)', async () => {
    const updated = makeCaptureRecord({ tags: [] })
    captureService.update.mockResolvedValueOnce(updated)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/cap-abc-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [] }),
    })

    expect(res.status).toBe(200)
  })

  it('passes metadata_overrides to update service', async () => {
    const updated = makeCaptureRecord()
    captureService.update.mockResolvedValueOnce(updated)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    await app.request('/api/v1/captures/cap-abc-123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata_overrides: { custom_field: 'value' } }),
    })

    expect(captureService.update).toHaveBeenCalledWith(
      'cap-abc-123',
      expect.objectContaining({ metadata_overrides: { custom_field: 'value' } }),
    )
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/captures/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/captures/:id', () => {
  let captureService: ReturnType<typeof makeMockCaptureService>
  let configService: ReturnType<typeof makeMockConfigService>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeMockCaptureService()
    configService = makeMockConfigService()
  })

  it('returns 204 on successful soft delete', async () => {
    captureService.softDelete.mockResolvedValueOnce(undefined)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/cap-abc-123', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(captureService.softDelete).toHaveBeenCalledWith('cap-abc-123')
  })

  it('returns 404 when capture does not exist', async () => {
    captureService.softDelete.mockRejectedValueOnce(new NotFoundError('Capture not found: missing-id'))

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/captures/missing-id', { method: 'DELETE' })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/stats
// ---------------------------------------------------------------------------

describe('GET /api/v1/stats', () => {
  let captureService: ReturnType<typeof makeMockCaptureService>
  let configService: ReturnType<typeof makeMockConfigService>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeMockCaptureService()
    configService = makeMockConfigService()
  })

  it('returns 200 with stats object', async () => {
    const stats = {
      total_captures: 42,
      by_source: { api: 30, slack: 12 },
      by_type: { idea: 20, task: 22 },
      by_view: { technical: 25, career: 17 },
      pipeline_health: { pending: 5, processing: 2, complete: 33, failed: 2 },
      total_entities: 0,
    }
    captureService.getStats.mockResolvedValueOnce(stats)

    const app = createApp({ captureService: captureService as any, configService: configService as any })
    const res = await app.request('/api/v1/stats')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total_captures).toBe(42)
    expect(body.by_source).toEqual({ api: 30, slack: 12 })
    expect(body.pipeline_health.pending).toBe(5)
    expect(body.total_entities).toBe(0)
  })

  it('returns 404 when captureService not registered (routes not mounted)', async () => {
    // Without deps, capture/stats routes are not registered
    const app = createApp({})
    const res = await app.request('/api/v1/stats')
    expect(res.status).toBe(404)
  })
})
