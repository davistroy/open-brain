/**
 * documents-routes-extra.test.ts — edge-case additions to document-routes.test.ts.
 *
 * The existing document-routes.test.ts is comprehensive for the primary
 * happy/sad paths. This file adds coverage for cases that file either skips
 * or only implicitly covers:
 *
 * Single upload (POST /api/v1/documents):
 *  - .htm extension resolves to text/html (same handler as .html, different ext)
 *  - source_metadata as JSON array is silently ignored (non-object shape)
 *  - Unknown source value (e.g. 'cloud') defaults to 'document'
 *
 * Batch upload (POST /api/v1/documents/batch):
 *  - files field is a non-array value (string, number)
 *  - negative file_size is not stored in source_metadata
 *  - tags field is a mixed array (non-strings) → defaults to []
 *  - brain_view defaults to 'technical' when absent on a batch item
 *  - batch at exactly MAX_BATCH_SIZE (100) is accepted
 *
 * Uses makeTestApp + testJson from helpers.ts per arch-review rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeTestApp, testJson } from './helpers.js'
import { registerDocumentRoutes } from '../routes/documents.js'
import type { CaptureService } from '../services/capture.js'
import type { ConfigService } from '@open-brain/shared'
import type { Queue } from 'bullmq'

// ---------------------------------------------------------------------------
// fs/promises mock — prevent disk writes during tests
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function makeCapture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-extra-001',
    content: '[Document] test',
    content_hash: 'hashXYZ',
    capture_type: 'observation',
    brain_view: 'technical',
    source: 'document',
    source_metadata: {},
    tags: [],
    pipeline_status: 'pending',
    pipeline_attempts: 0,
    created_at: new Date('2026-05-05T10:00:00Z'),
    updated_at: new Date('2026-05-05T10:00:00Z'),
    captured_at: new Date('2026-05-05T10:00:00Z'),
    ...overrides,
  }
}

/**
 * Returns an untyped mock bag whose create() is a vi.fn() that tests can
 * call .mockResolvedValue on. Cast to CaptureService only at the DI boundary.
 */
function makeCaptureService(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn().mockResolvedValue(makeCapture()),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    getStats: vi.fn(),
    ...overrides,
  }
}

function makeConfigService(views = ['technical', 'career', 'personal', 'work-internal', 'client']) {
  return {
    getBrainViews: vi.fn().mockReturnValue(views),
    get: vi.fn(),
    load: vi.fn(),
    reload: vi.fn(),
  }
}

function makePipelineQueue() {
  return { add: vi.fn().mockResolvedValue({ id: 'q-job-001' }) }
}

function buildApp(
  captureService: ReturnType<typeof makeCaptureService>,
  configService: ReturnType<typeof makeConfigService>,
  queue: ReturnType<typeof makePipelineQueue>,
) {
  return makeTestApp((app) => {
    registerDocumentRoutes(
      app,
      captureService as unknown as CaptureService,
      configService as unknown as ConfigService,
      queue as unknown as Queue,
    )
  })
}

function makeFormFile(opts: {
  filename?: string
  mimeType?: string
  content?: string
} = {}): FormData {
  const {
    filename = 'test.pdf',
    mimeType = 'application/pdf',
    content = '%PDF-1.4 mock',
  } = opts
  const file = new File([content], filename, { type: mimeType })
  const fd = new FormData()
  fd.append('file', file, filename)
  return fd
}

function makeFileRef(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test Document',
    original_path: '/mnt/onedrive/docs/test.pdf',
    mime_type: 'application/pdf',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/documents — edge cases
// ---------------------------------------------------------------------------

describe('POST /api/v1/documents — edge cases', () => {
  let captureService: ReturnType<typeof makeCaptureService>
  let configService: ReturnType<typeof makeConfigService>
  let queue: ReturnType<typeof makePipelineQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeCaptureService()
    configService = makeConfigService()
    queue = makePipelineQueue()
  })

  it('.htm extension resolves to text/html mime type', async () => {
    captureService.create.mockResolvedValue(makeCapture({
      source_metadata: { filename: 'page.htm', mime_type: 'text/html' },
    }))
    const app = buildApp(captureService, configService, queue)

    const fd = makeFormFile({ filename: 'page.htm', mimeType: 'application/octet-stream' })
    const res = await app.request('/api/v1/documents', {
      method: 'POST',
      body: fd,
    })

    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    // .htm → EXT_TO_MIME → text/html; generic application/octet-stream is ignored
    expect(body.mime_type).toBe('text/html')
  })

  it('source_metadata that is a JSON array is silently ignored (non-object shape)', async () => {
    captureService.create.mockResolvedValue(makeCapture())
    const app = buildApp(captureService, configService, queue)

    const fd = makeFormFile()
    fd.append('source_metadata', JSON.stringify(['array', 'value']))
    const res = await app.request('/api/v1/documents', {
      method: 'POST',
      body: fd,
    })

    // Array-shaped source_metadata is a non-object — route skips it, no 400
    expect(res.status).toBe(201)
    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          // Array content NOT spread into source_metadata
          source_metadata: expect.not.objectContaining({ '0': 'array' }),
        }),
      }),
    )
  })

  it('source value other than "file" defaults to "document"', async () => {
    captureService.create.mockResolvedValue(makeCapture())
    const app = buildApp(captureService, configService, queue)

    const fd = makeFormFile()
    fd.append('source', 'cloud')
    const res = await app.request('/api/v1/documents', {
      method: 'POST',
      body: fd,
    })

    expect(res.status).toBe(201)
    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'document' }),
    )
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/documents/batch — edge cases
// ---------------------------------------------------------------------------

describe('POST /api/v1/documents/batch — edge cases', () => {
  let captureService: ReturnType<typeof makeCaptureService>
  let configService: ReturnType<typeof makeConfigService>
  let queue: ReturnType<typeof makePipelineQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    captureService = makeCaptureService()
    configService = makeConfigService()
    queue = makePipelineQueue()
  })

  function makeApp() {
    return buildApp(captureService, configService, queue)
  }

  it('returns 400 when files is a string (not an array)', async () => {
    const app = makeApp()
    const { status, body } = await testJson(app, '/api/v1/documents/batch', {
      method: 'POST',
      body: JSON.stringify({ files: 'not-an-array' }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('files')
  })

  it('returns 400 when files is a number', async () => {
    const app = makeApp()
    const { status, body } = await testJson(app, '/api/v1/documents/batch', {
      method: 'POST',
      body: JSON.stringify({ files: 42 }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('files')
  })

  it('negative file_size is not stored in source_metadata', async () => {
    captureService.create.mockResolvedValue(makeCapture({ source: 'file' }))
    const app = makeApp()

    await testJson(app, '/api/v1/documents/batch', {
      method: 'POST',
      body: JSON.stringify({
        files: [makeFileRef({ file_size: -100 })],
      }),
    })

    // file_size < 0 fails the `>= 0` guard → not included in fileSourceMeta
    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source_metadata: expect.not.objectContaining({ file_size: -100 }),
        }),
      }),
    )
  })

  it('tags field with non-string elements defaults to empty array', async () => {
    captureService.create.mockResolvedValue(makeCapture({ source: 'file' }))
    const app = makeApp()

    await testJson(app, '/api/v1/documents/batch', {
      method: 'POST',
      body: JSON.stringify({
        files: [makeFileRef({ tags: [1, 2, 'valid', null] })],
      }),
    })

    // Mixed-type tags fail every() string check → route defaults to []
    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ tags: [] }),
      }),
    )
  })

  it('brain_view defaults to technical when absent on a batch item', async () => {
    captureService.create.mockResolvedValue(makeCapture({ source: 'file' }))
    const app = makeApp()

    // No brain_view in payload
    const ref = { title: 'Doc Without View', original_path: '/mnt/doc.pdf', mime_type: 'application/pdf' }
    await testJson(app, '/api/v1/documents/batch', {
      method: 'POST',
      body: JSON.stringify({ files: [ref] }),
    })

    expect(captureService.create).toHaveBeenCalledWith(
      expect.objectContaining({ brain_view: 'technical' }),
    )
  })

  it('accepts batch of exactly 100 items (MAX_BATCH_SIZE boundary — inclusive)', async () => {
    captureService.create.mockResolvedValue(makeCapture({ source: 'file' }))
    const app = makeApp()

    const files = Array.from({ length: 100 }, (_, i) => makeFileRef({ title: `Doc ${i}` }))
    const { status, body } = await testJson(app, '/api/v1/documents/batch', {
      method: 'POST',
      body: JSON.stringify({ files }),
    })

    expect(status).toBe(201)
    expect((body as any).queued).toBe(100)
    expect((body as any).errors).toBe(0)
  })
})
