import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import { ConflictError } from '@open-brain/shared'
import type { CaptureRecord } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock infrastructure dependencies (same pattern as captures-routes.test.ts)
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

// Mock node:fs/promises so file writes don't touch disk during tests
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeDocumentCaptureRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: 'doc-cap-abc-123',
    content: '[Document] test document',
    content_hash: 'hash456',
    capture_type: 'observation',
    brain_view: 'technical',
    source: 'document',
    source_metadata: {
      filename: 'test-document.pdf',
      mime_type: 'application/pdf',
      title: 'test document',
      file_path: '/tmp/open-brain-uploads/some-uuid.pdf',
      upload_status: 'pending_extraction',
    },
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

function makeMockDocumentPipelineQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-123' }),
  }
}

/**
 * Build a FormData containing a minimal file upload.
 * Uses the web-standard File and FormData APIs (available in Node 18+).
 */
function makeFormData(opts: {
  filename?: string
  mimeType?: string
  content?: string
  brain_view?: string
  tags?: string
  title?: string
} = {}): FormData {
  const {
    filename = 'test-document.pdf',
    mimeType = 'application/pdf',
    content = '%PDF-1.4 mock content',
    brain_view,
    tags,
    title,
  } = opts

  const file = new File([content], filename, { type: mimeType })
  const fd = new FormData()
  fd.append('file', file, filename)
  if (brain_view !== undefined) fd.append('brain_view', brain_view)
  if (tags !== undefined) fd.append('tags', tags)
  if (title !== undefined) fd.append('title', title)
  return fd
}

// ---------------------------------------------------------------------------
// POST /api/v1/documents
// ---------------------------------------------------------------------------

describe('POST /api/v1/documents', () => {
  let captureService: ReturnType<typeof makeMockCaptureService>
  let configService: ReturnType<typeof makeMockConfigService>
  let documentPipelineQueue: ReturnType<typeof makeMockDocumentPipelineQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeMockCaptureService()
    configService = makeMockConfigService()
    documentPipelineQueue = makeMockDocumentPipelineQueue()
  })

  it('returns 201 with capture_id, filename, mime_type, and pipeline_status on PDF upload', async () => {
    const record = makeDocumentCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = makeFormData()
    const res = await app.request('/api/v1/documents', {
      method: 'POST',
      body: fd,
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.capture_id).toBe('doc-cap-abc-123')
    expect(body.filename).toBe('test-document.pdf')
    expect(body.mime_type).toBe('application/pdf')
    expect(body.pipeline_status).toBe('pending')
  })

  it('creates capture with source=document', async () => {
    const record = makeDocumentCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    await app.request('/api/v1/documents', { method: 'POST', body: makeFormData() })

    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'document' }),
    )
  })

  it('stores filename and mime_type in source_metadata', async () => {
    const record = makeDocumentCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    await app.request('/api/v1/documents', { method: 'POST', body: makeFormData() })

    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source_metadata: expect.objectContaining({
            filename: 'test-document.pdf',
            mime_type: 'application/pdf',
            upload_status: 'pending_extraction',
          }),
        }),
      }),
    )
  })

  it('enqueues document-pipeline job with jobId=document:<captureId>', async () => {
    const record = makeDocumentCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    await app.request('/api/v1/documents', { method: 'POST', body: makeFormData() })

    expect(documentPipelineQueue.add).toHaveBeenCalledWith(
      'document-pipeline',
      { captureId: 'doc-cap-abc-123' },
      { jobId: 'document:doc-cap-abc-123' },
    )
  })

  it('accepts DOCX file and resolves mime type from extension', async () => {
    const record = makeDocumentCaptureRecord({
      source_metadata: {
        filename: 'report.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    })
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = makeFormData({ filename: 'report.docx', mimeType: 'application/octet-stream' })
    const res = await app.request('/api/v1/documents', { method: 'POST', body: fd })

    expect(res.status).toBe(201)
    const body = await res.json()
    // Resolves from .docx extension, ignoring generic application/octet-stream
    expect(body.mime_type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('accepts MD, TXT, and HTML files', async () => {
    for (const filename of ['notes.md', 'readme.txt', 'page.html']) {
      const record = makeDocumentCaptureRecord({ source_metadata: { filename } })
      captureService.create.mockResolvedValueOnce(record)

      const app = createApp({
        captureService: captureService as any,
        configService: configService as any,
        documentPipelineQueue: documentPipelineQueue as any,
      })

      const fd = makeFormData({ filename, mimeType: 'application/octet-stream' })
      const res = await app.request('/api/v1/documents', { method: 'POST', body: fd })
      expect(res.status).toBe(201)
    }
  })

  it('uses title override as capture content when provided', async () => {
    const record = makeDocumentCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = makeFormData({ title: 'My Custom Title' })
    await app.request('/api/v1/documents', { method: 'POST', body: fd })

    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[Document] My Custom Title' }),
    )
  })

  it('applies brain_view from form field', async () => {
    const record = makeDocumentCaptureRecord({ brain_view: 'career' })
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = makeFormData({ brain_view: 'career' })
    await app.request('/api/v1/documents', { method: 'POST', body: fd })

    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({ brain_view: 'career' }),
    )
  })

  it('applies tags from comma-separated form field', async () => {
    const record = makeDocumentCaptureRecord({ tags: ['ml', 'research'] })
    captureService.create.mockResolvedValueOnce(record)

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = makeFormData({ tags: 'ml,research' })
    await app.request('/api/v1/documents', { method: 'POST', body: fd })

    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ tags: ['ml', 'research'] }),
      }),
    )
  })

  it('returns 400 when file field is missing', async () => {
    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = new FormData()
    fd.append('brain_view', 'technical')
    const res = await app.request('/api/v1/documents', { method: 'POST', body: fd })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for unsupported file type', async () => {
    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = makeFormData({ filename: 'image.jpg', mimeType: 'image/jpeg' })
    const res = await app.request('/api/v1/documents', { method: 'POST', body: fd })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('Unsupported file type')
  })

  it('returns 400 for invalid brain_view', async () => {
    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const fd = makeFormData({ brain_view: 'not-a-real-view' })
    const res = await app.request('/api/v1/documents', { method: 'POST', body: fd })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('Invalid brain_view')
  })

  it('returns 409 on duplicate capture', async () => {
    captureService.create.mockRejectedValueOnce(
      new ConflictError('Duplicate capture detected within the last 60 seconds (id: existing-id)'),
    )

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const res = await app.request('/api/v1/documents', { method: 'POST', body: makeFormData() })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('CONFLICT')
  })

  it('succeeds without document-pipeline queue (capture is still created)', async () => {
    const record = makeDocumentCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)

    // No documentPipelineQueue injected
    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
    })

    const res = await app.request('/api/v1/documents', { method: 'POST', body: makeFormData() })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.capture_id).toBe('doc-cap-abc-123')
  })

  it('succeeds even when queue.add fails (enqueue failure is non-fatal)', async () => {
    const record = makeDocumentCaptureRecord()
    captureService.create.mockResolvedValueOnce(record)
    documentPipelineQueue.add.mockRejectedValueOnce(new Error('Redis connection refused'))

    const app = createApp({
      captureService: captureService as any,
      configService: configService as any,
      documentPipelineQueue: documentPipelineQueue as any,
    })

    const res = await app.request('/api/v1/documents', { method: 'POST', body: makeFormData() })

    // Upload still succeeds — enqueue failure is logged but not propagated
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.capture_id).toBe('doc-cap-abc-123')
  })

  it('returns 404 when captureService and configService not registered', async () => {
    const app = createApp({})
    const res = await app.request('/api/v1/documents', { method: 'POST', body: makeFormData() })
    expect(res.status).toBe(404)
  })
})
