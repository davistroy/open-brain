import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Writable } from 'node:stream'

// ---------------------------------------------------------------------------
// Phase 3.3 — Ingest route unit tests
//
// Covers `packages/core-api/src/routes/ingest.ts`:
//   POST /api/v1/ingest/upload
//   GET  /api/v1/ingest/uploads
//   GET  /api/v1/ingest/uploads/:id          → 404 UploadNotFoundError
//   POST /api/v1/ingest/uploads/:id/process  → re-enqueue
//   POST /api/v1/ingest/process-now          → manual scan-inbox trigger
//
// Notes on plan items that DO NOT apply to this route file:
//   • "Document title hash collision returns 409" — that 409 lives in
//     `routes/documents.ts` (POST /api/v1/documents) and is exercised by
//     `document-routes.test.ts`. The ingest route in this file does NOT
//     perform title-hash conflict checks.
//   • "HMAC trigger endpoint validates signature" — HMAC validation lives
//     in the Python sidecar (`docker/ingest-sidecar/trigger_server.py`),
//     not in the TypeScript ingest route. core-api's only auth on these
//     endpoints is the `BYPASS_CALLERS` rate-limit allow-list; the
//     internal-network boundary is the policy.
//
// Disallowed-mime validation: the upload endpoint accepts any reported
// MIME (it is informational on this surface — the heavy MIME gating lives
// in `routes/documents.ts`). What the upload endpoint DOES strictly
// validate is `source_type` ∈ {'financial','utility'}, so we test the
// disallowed-source path as the surrogate "disallowed mime" scenario.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Infrastructure mocks (must come before importing app.js)
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

// Disk-touching helpers: `mkdir` from fs/promises and `createWriteStream`
// from fs. We replace both so streamBodyToFile() succeeds without
// allocating a real file handle.
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...orig,
    mkdir: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    createWriteStream: vi.fn().mockImplementation(() => {
      // Minimal Writable that swallows everything synchronously and
      // emits `finish` when end() is called. ingest.ts wraps this in its
      // own Writable counter, so this only needs to absorb writes.
      const sink = new Writable({
        write(_chunk, _enc, cb) {
          cb()
        },
        final(cb) {
          cb()
        },
      })
      return sink
    }),
  }
})

import { createApp } from '../app.js'
import { DEFAULT_HEADERS } from './helpers.js'

// ---------------------------------------------------------------------------
// Sample rows
// ---------------------------------------------------------------------------

const SAMPLE_UPLOAD_ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  filename: 'activity.csv',
  size_bytes: 2048,
  mime_type: 'text/csv',
  source_type: 'financial' as const,
  parser_hint: 'amex',
  destination_path: '/app/inbox-volumes/financial/abc.csv',
  uploaded_at: new Date('2026-04-21T10:00:00Z'),
  status: 'pending' as const,
  capture_ids: [] as string[],
  error_message: null as string | null,
  processed_at: null as Date | null,
  duration_ms: null as number | null,
}

// ---------------------------------------------------------------------------
// DB mock factory
//
// ingest.ts uses these query shapes:
//   1. db.insert(file_uploads).values(...).returning()      → [row]
//   2. db.select().from(file_uploads).where(?).orderBy().limit().offset() → rows  (list)
//   3. db.select({count}).from(file_uploads).where(?)       → [{count}]  (count)
//   4. db.select().from(file_uploads).where().limit(1)      → rows  (get-by-id / process)
//   5. db.update(file_uploads).set().where()                → undefined
//   6. db.select().from(captures).where(inArray(...))       → rows  (shapeFileUploadRow)
//
// We use a select-call-index alternation: even index = items/get path,
// odd index = count path.
// ---------------------------------------------------------------------------

interface MakeMockDbOpts {
  /** Rows returned by the "list" / "get-by-id" select chains. */
  selectRows?: unknown[]
  /** Rows returned by the count select chain. */
  countRows?: { count: number }[]
  /** Row returned by the insert .returning() call. */
  insertResult?: unknown[]
  /** Captures-side join rows for shapeFileUploadRow (defaults to []). */
  captureRows?: unknown[]
}

function makeMockDb(opts: MakeMockDbOpts = {}) {
  const {
    selectRows = [SAMPLE_UPLOAD_ROW],
    countRows = [{ count: 1 }],
    insertResult = [SAMPLE_UPLOAD_ROW],
    captureRows = [],
  } = opts

  let selectCallIndex = 0

  const db = {
    select: vi.fn().mockImplementation((..._args: unknown[]) => {
      const callIndex = selectCallIndex++

      // The list endpoint runs the items query and the count query in
      // Promise.all → call indexes 0 and 1 alternate. shapeFileUploadRow
      // also issues a `select({id, content}).from(captures)` whenever the
      // upload row has capture_ids — we send those to `captureRows` via
      // a separate `from()` branch.
      const limitOffsetThen = vi.fn().mockResolvedValue(selectRows)
      const offsetMock = vi.fn().mockResolvedValue(selectRows)
      const limitAfterOrderBy = vi.fn().mockReturnValue({ offset: offsetMock, then: (cb: any) => Promise.resolve(selectRows).then(cb) })
      const orderByMock = vi.fn().mockReturnValue({
        limit: limitAfterOrderBy,
        offset: offsetMock,
        then: (cb: any) => Promise.resolve(selectRows).then(cb),
      })
      const limitDirectMock = vi.fn().mockResolvedValue(selectRows) // get-by-id path

      const whereMock = vi.fn().mockReturnValue({
        orderBy: orderByMock,
        limit: limitDirectMock,
        // A bare-await on the count query: db.select({count}).from(...).where(...)
        then: (cb: any) =>
          (callIndex % 2 === 1 ? Promise.resolve(countRows) : Promise.resolve(selectRows)).then(cb),
      })

      const fromMock = vi.fn().mockImplementation((tbl: unknown) => {
        // Detect captures-side select used by shapeFileUploadRow. The Drizzle
        // `captures` symbol is identity-different from `file_uploads`, but our
        // mock can't easily tell — use a heuristic: when `captureRows` is the
        // intended return (call paths driven by inArray()), we expose a
        // bare-await chain on `where`. The captures select call always uses
        // .where() and is awaited directly without limit/orderBy.
        void tbl
        return {
          where: whereMock,
          orderBy: orderByMock,
          limit: limitOffsetThen,
        }
      })

      // Special-case the captures select: when shapeFileUploadRow runs,
      // it does `db.select({id, content}).from(captures).where(inArray(...))`.
      // We assume any select() called with a non-empty arg is the captures
      // join — return a chain that resolves to captureRows on `where()`.
      const calledWithProjection = _args.length > 0 && typeof _args[0] === 'object' && _args[0] !== null
      if (calledWithProjection && callIndex > 0) {
        const captureWhere = vi.fn().mockResolvedValue(captureRows)
        return { from: vi.fn().mockReturnValue({ where: captureWhere }) }
      }

      return { from: fromMock }
    }),

    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertResult),
      }),
    }),

    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }

  return db
}

// Minimal BullMQ queue mock matching `Queue<IngestProcessJobData>`.
function makeMockIngestProcessQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'ingest-job-1' }),
  }
}

// Build a multipart FormData with a `file` field.
function makeFormData(opts: {
  filename?: string
  mimeType?: string
  content?: string
  source_type?: string
  parser_hint?: string
} = {}): FormData {
  const {
    filename = 'activity.csv',
    mimeType = 'text/csv',
    content = 'date,desc,amount\n2026-04-01,Coffee,4.25',
    source_type,
    parser_hint,
  } = opts
  const file = new File([content], filename, { type: mimeType })
  const fd = new FormData()
  fd.append('file', file, filename)
  if (source_type !== undefined) fd.append('source_type', source_type)
  if (parser_hint !== undefined) fd.append('parser_hint', parser_hint)
  return fd
}

// ---------------------------------------------------------------------------
// POST /api/v1/ingest/upload
// ---------------------------------------------------------------------------

describe('POST /api/v1/ingest/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 201 with upload_id, status, source_type for a recognised filename', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: makeFormData({ filename: 'activity.csv', mimeType: 'text/csv' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.upload_id).toBe(SAMPLE_UPLOAD_ROW.id)
    expect(body.status).toBe('pending')
    expect(body.source_type).toBe('financial')
    expect(body.filename).toBe('activity.csv')
  })

  it('enqueues an ingest-process job after a successful upload', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: makeFormData(),
    })

    expect(ingestProcessQueue.add).toHaveBeenCalledTimes(1)
    expect(ingestProcessQueue.add).toHaveBeenCalledWith(
      'ingest-process',
      expect.objectContaining({
        upload_id: SAMPLE_UPLOAD_ROW.id,
        source_type: 'financial',
      }),
      expect.objectContaining({
        jobId: `ingest_${SAMPLE_UPLOAD_ROW.id}`,
        attempts: 3,
      }),
    )
  })

  it('returns 400 when no file field is supplied (multipart body but missing file)', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const fd = new FormData()
    fd.append('source_type', 'financial')
    const res = await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: fd,
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('file')
  })

  it('returns 400 when source_type is invalid (not "financial" or "utility")', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: makeFormData({ source_type: 'application/x-msdownload' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when filename does not match any router heuristic AND no source_type override', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: makeFormData({ filename: 'mystery_file.csv' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toContain('source_type')
  })

  it('accepts an explicit source_type=utility override', async () => {
    const db = makeMockDb({
      insertResult: [{ ...SAMPLE_UPLOAD_ROW, source_type: 'utility', filename: 'random.csv' }],
    })
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: makeFormData({ filename: 'random.csv', source_type: 'utility' }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.source_type).toBe('utility')
  })

  it('persists the upload even when ingestProcessQueue is undefined', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: makeFormData(),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.upload_id).toBe(SAMPLE_UPLOAD_ROW.id)
  })

  it('still returns 201 when queue.add() throws (enqueue failure is non-fatal)', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    ingestProcessQueue.add.mockRejectedValueOnce(new Error('Redis connection refused'))
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request('/api/v1/ingest/upload', {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: makeFormData(),
    })

    expect(res.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/ingest/uploads/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/ingest/uploads/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 + UPLOAD_NOT_FOUND when row is missing', async () => {
    const db = makeMockDb({ selectRows: [], countRows: [{ count: 0 }] })
    const app = createApp({ db: db as any })

    const res = await app.request(
      '/api/v1/ingest/uploads/00000000-0000-4000-8000-000000000000',
      { method: 'GET', headers: DEFAULT_HEADERS },
    )

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('UPLOAD_NOT_FOUND')
  })

  it('returns 400 for a non-UUID :id (Zod rejects)', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/ingest/uploads/not-a-uuid', {
      method: 'GET',
      headers: DEFAULT_HEADERS,
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/ingest/uploads/:id/process
// ---------------------------------------------------------------------------

describe('POST /api/v1/ingest/uploads/:id/process', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-enqueues an existing upload and returns enqueued: true', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request(
      `/api/v1/ingest/uploads/${SAMPLE_UPLOAD_ROW.id}/process`,
      { method: 'POST', headers: DEFAULT_HEADERS },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.source).toBe('financial')
    expect(body.enqueued).toBe(true)
    expect(ingestProcessQueue.add).toHaveBeenCalledTimes(1)
  })

  it('returns 404 + UPLOAD_NOT_FOUND when the row does not exist', async () => {
    const db = makeMockDb({ selectRows: [] })
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request(
      `/api/v1/ingest/uploads/${SAMPLE_UPLOAD_ROW.id}/process`,
      { method: 'POST', headers: DEFAULT_HEADERS },
    )

    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.code).toBe('UPLOAD_NOT_FOUND')
  })

  it('returns 503 with enqueued: false when no queue is configured', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request(
      `/api/v1/ingest/uploads/${SAMPLE_UPLOAD_ROW.id}/process`,
      { method: 'POST', headers: DEFAULT_HEADERS },
    )

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.enqueued).toBe(false)
    expect(body.message).toContain('queue not configured')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/ingest/process-now
// ---------------------------------------------------------------------------

describe('POST /api/v1/ingest/process-now', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults source to "financial" when no query param is supplied', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request('/api/v1/ingest/process-now', {
      method: 'POST',
      headers: DEFAULT_HEADERS,
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.source).toBe('financial')
    expect(body.enqueued).toBe(true)
    expect(ingestProcessQueue.add).toHaveBeenCalledWith(
      'ingest-process',
      expect.objectContaining({
        source_type: 'financial',
        // The "scan inbox" sentinel — worker treats this as a manual trigger.
        upload_id: '00000000-0000-0000-0000-000000000000',
      }),
      expect.any(Object),
    )
  })

  it('returns 503 with enqueued: false when no queue is configured', async () => {
    const db = makeMockDb()
    const app = createApp({ db: db as any })

    const res = await app.request('/api/v1/ingest/process-now?source=utility', {
      method: 'POST',
      headers: DEFAULT_HEADERS,
    })

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.source).toBe('utility')
    expect(body.enqueued).toBe(false)
  })

  it('returns 400 when source query param is invalid', async () => {
    const db = makeMockDb()
    const ingestProcessQueue = makeMockIngestProcessQueue()
    const app = createApp({ db: db as any, ingestProcessQueue: ingestProcessQueue as any })

    const res = await app.request('/api/v1/ingest/process-now?source=bogus', {
      method: 'POST',
      headers: DEFAULT_HEADERS,
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })
})
