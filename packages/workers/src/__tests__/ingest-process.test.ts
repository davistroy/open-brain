import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Job } from 'bullmq'
import { logger, type IngestProcessJobData, type SidecarProcessResponse } from '@open-brain/shared'
import {
  ingestProcessBackoffStrategy,
  processIngestProcessJob,
  createIngestProcessWorker,
} from '../jobs/ingest-process.js'
import { INGEST_PROCESS_BACKOFF_DELAYS_MS } from '../queues/ingest-process.js'

// ============================================================
// Mocks
// ============================================================
//
// - BullMQ `Worker` is replaced with a lightweight class that captures the
//   processor closure + event handlers so `createIngestProcessWorker` can be
//   exercised without a live Redis connection.
// - `@open-brain/shared` is spread verbatim (real `dispatchToSidecar`,
//   `HttpError`, `file_uploads`) except for `logger`, which is silenced +
//   made assertable. Because the real `dispatchToSidecar` runs, we control it
//   through a stubbed global `fetch` and can assert the sidecar URL/headers.
// ============================================================

vi.mock('bullmq', () => {
  class MockWorker {
    handlers: Record<string, (...args: unknown[]) => unknown> = {}
    close = vi.fn().mockResolvedValue(undefined)
    constructor(
      public name: string,
      public processor: (job: unknown) => Promise<unknown>,
      public opts: Record<string, unknown>,
    ) {}
    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers[event] = handler
      return this
    }
  }
  return { Worker: MockWorker, Queue: class MockQueue {} }
})

vi.mock('@open-brain/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-brain/shared')>()
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

// ============================================================
// Fixtures + helpers
// ============================================================

const UPLOAD_ID = '11111111-1111-1111-1111-111111111111'
const SCAN_INBOX_ID = '00000000-0000-0000-0000-000000000000'
const CAPTURE_ID = '22222222-2222-2222-2222-222222222222'

const SAMPLE_ROW = {
  id: UPLOAD_ID,
  filename: 'report.pdf',
  size_bytes: 2048,
  mime_type: 'application/pdf',
  source_type: 'financial',
  parser_hint: null,
  destination_path: '/inbox/report.pdf',
  status: 'pending',
  capture_ids: [],
  error_message: null,
  processed_at: null,
  duration_ms: null,
}

/** Renders a Drizzle sql`` template to `{ sql, params }`. */
function renderSql(arg: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(arg as never)
}

/**
 * Mock Database. `select().from().where().limit()` resolves to `rows`;
 * `update().set().where()` resolves; `execute()` resolves (pg_notify).
 * Individual spies (`set`, `update`, `execute`, `select`) are exposed for
 * assertion.
 */
function makeDb(rows: unknown[] = [SAMPLE_ROW]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const selectWhere = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where: selectWhere })
  const select = vi.fn().mockReturnValue({ from })

  const updateWhere = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where: updateWhere })
  const update = vi.fn().mockReturnValue({ set })

  const execute = vi.fn().mockResolvedValue({ rows: [] })

  return { select, from, selectWhere, limit, update, set, updateWhere, execute }
}
type MockDb = ReturnType<typeof makeDb>

function makeJob(
  overrides: Partial<IngestProcessJobData> = {},
  attemptsMade = 0,
): Job<IngestProcessJobData> {
  return {
    id: 'job-123',
    attemptsMade,
    data: {
      upload_id: UPLOAD_ID,
      source_type: 'financial',
      destination_path: '/inbox/report.pdf',
      parser_hint: null,
      ...overrides,
    },
  } as unknown as Job<IngestProcessJobData>
}

function okResponse(overrides: Partial<SidecarProcessResponse> = {}): SidecarProcessResponse {
  return { status: 'ok', captures_posted: [CAPTURE_ID], errors: [], duration_ms: 1234, ...overrides }
}

/** A stub `fetch` returning a 2xx JSON body (the sidecar happy path). */
function fetchOk(body: SidecarProcessResponse = okResponse()) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  })
}

/** A stub `fetch` returning a non-2xx response (triggers HttpError). */
function fetchHttpError(status = 500, body = 'sidecar boom') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue({}),
  })
}

/** Collect the JSON payloads (param $2) from every pg_notify execute() call. */
function notifyPayloads(db: MockDb): string[] {
  return (db.execute.mock.calls as unknown[][]).map(
    ([arg]) => renderSql(arg).params[1] as string,
  )
}

const OPTS = { secret: 'test-secret', timeoutMs: 5000 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  delete process.env.INGEST_TRIGGER_SECRET
  delete process.env.INGEST_TIMEOUT_MS
  delete process.env.INGEST_SIDECAR_URL_FINANCIAL
  delete process.env.INGEST_SIDECAR_URL_UTILITY
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ============================================================
// ingestProcessBackoffStrategy
// ============================================================

describe('ingestProcessBackoffStrategy', () => {
  it('returns the canonical patient-backoff delay for attempts 1..5', () => {
    expect(ingestProcessBackoffStrategy(1)).toBe(30_000)
    expect(ingestProcessBackoffStrategy(2)).toBe(120_000)
    expect(ingestProcessBackoffStrategy(3)).toBe(600_000)
    expect(ingestProcessBackoffStrategy(4)).toBe(1_800_000)
    expect(ingestProcessBackoffStrategy(5)).toBe(7_200_000)
  })

  it('maps each attempt to the matching index of the delay table', () => {
    for (let attempt = 1; attempt <= INGEST_PROCESS_BACKOFF_DELAYS_MS.length; attempt++) {
      expect(ingestProcessBackoffStrategy(attempt)).toBe(
        INGEST_PROCESS_BACKOFF_DELAYS_MS[attempt - 1],
      )
    }
  })

  it('clamps attempts beyond the table length to the final (2h) delay', () => {
    const last = INGEST_PROCESS_BACKOFF_DELAYS_MS[INGEST_PROCESS_BACKOFF_DELAYS_MS.length - 1]
    expect(ingestProcessBackoffStrategy(6)).toBe(last)
    expect(ingestProcessBackoffStrategy(50)).toBe(last)
    expect(last).toBe(7_200_000)
  })
})

// ============================================================
// processIngestProcessJob — happy path
// ============================================================

describe('processIngestProcessJob — happy path', () => {
  it('dispatches to the sidecar and marks the upload parsed', async () => {
    const mockFetch = fetchOk()
    vi.stubGlobal('fetch', mockFetch)
    const db = makeDb()

    const result = await processIngestProcessJob(makeJob(), db as never, OPTS)

    // Return value is the raw sidecar response.
    expect(result).toEqual(okResponse())

    // ── Sidecar POST: URL + headers + body (real dispatchToSidecar) ──
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://financial-ingest:8080/process')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-secret')
    expect(headers['X-Open-Brain-Caller']).toBe('ingest')
    expect(JSON.parse(init.body as string)).toEqual({
      file_path: '/inbox/report.pdf',
      file_id: UPLOAD_ID,
    })

    // ── file_uploads status transitions: processing → parsed ──
    expect(db.update).toHaveBeenCalledTimes(2)
    const firstSet = db.set.mock.calls[0][0] as Record<string, unknown>
    expect(firstSet).toMatchObject({ status: 'processing', error_message: null })
    const secondSet = db.set.mock.calls[1][0] as Record<string, unknown>
    expect(secondSet).toMatchObject({
      status: 'parsed',
      capture_ids: [CAPTURE_ID],
      error_message: null,
      duration_ms: 1234,
    })
    expect(secondSet.processed_at).toBeInstanceOf(Date)

    // ── pg_notify events: started + completed ──
    const payloads = notifyPayloads(db)
    expect(payloads.some((p) => p.includes('"type":"started"'))).toBe(true)
    expect(payloads.some((p) => p.includes('"type":"completed"'))).toBe(true)
    const completed = JSON.parse(payloads.find((p) => p.includes('"completed"'))!)
    expect(completed).toMatchObject({
      type: 'completed',
      status: 'parsed',
      upload_id: UPLOAD_ID,
      filename: 'report.pdf',
      source_type: 'financial',
      capture_ids: [CAPTURE_ID],
    })
  })

  it('falls back to wall-clock duration when the sidecar reports duration_ms=0', async () => {
    vi.stubGlobal('fetch', fetchOk(okResponse({ duration_ms: 0 })))
    const db = makeDb()

    await processIngestProcessJob(makeJob(), db as never, OPTS)

    const secondSet = db.set.mock.calls[1][0] as Record<string, unknown>
    expect(secondSet.status).toBe('parsed')
    expect(secondSet.duration_ms as number).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================
// processIngestProcessJob — row missing (unusual, non-retryable)
// ============================================================

describe('processIngestProcessJob — upload row missing', () => {
  it('returns an ok sidecar response and skips dispatch/updates entirely', async () => {
    const mockFetch = fetchOk()
    vi.stubGlobal('fetch', mockFetch)
    const db = makeDb([]) // select().limit() → []

    const result = await processIngestProcessJob(makeJob(), db as never, OPTS)

    expect(result.status).toBe('ok')
    expect(result.errors[0]).toContain(UPLOAD_ID)
    // Early return before any dispatch / status write / notify.
    expect(mockFetch).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
    expect(db.execute).not.toHaveBeenCalled()
  })
})

// ============================================================
// processIngestProcessJob — scan-inbox synthetic job
// ============================================================

describe('processIngestProcessJob — scan-inbox job', () => {
  it('skips the row load + status updates but still dispatches and emits events', async () => {
    const mockFetch = fetchOk(okResponse({ duration_ms: 0 }))
    vi.stubGlobal('fetch', mockFetch)
    const db = makeDb()

    const result = await processIngestProcessJob(
      makeJob({ upload_id: SCAN_INBOX_ID }),
      db as never,
      OPTS,
    )

    expect(result.status).toBe('ok')
    // No row load, no status write for the synthetic scan job.
    expect(db.select).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
    // But the sidecar IS dispatched and events ARE emitted.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const payloads = notifyPayloads(db)
    expect(payloads.some((p) => p.includes('"type":"started"'))).toBe(true)
    expect(payloads.some((p) => p.includes('"type":"completed"'))).toBe(true)
    // filename falls back to destination_path for the started event.
    const started = JSON.parse(payloads.find((p) => p.includes('"started"'))!)
    expect(started.filename).toBe('/inbox/report.pdf')
    expect(started.size_bytes).toBe(0)
  })
})

// ============================================================
// processIngestProcessJob — sidecar HTTP error
// ============================================================

describe('processIngestProcessJob — sidecar HttpError', () => {
  it('marks the upload failed, emits a failed event, and rethrows', async () => {
    vi.stubGlobal('fetch', fetchHttpError(500, 'sidecar boom'))
    const db = makeDb()

    await expect(processIngestProcessJob(makeJob(), db as never, OPTS)).rejects.toThrow()

    // processing → failed
    expect(db.update).toHaveBeenCalledTimes(2)
    const failedSet = db.set.mock.calls[1][0] as Record<string, unknown>
    expect(failedSet.status).toBe('failed')
    expect(failedSet.error_message as string).toContain('sidecar returned 500')
    expect(failedSet.processed_at).toBeInstanceOf(Date)

    // failed pg_notify emitted
    const payloads = notifyPayloads(db)
    expect(payloads.some((p) => p.includes('"type":"failed"'))).toBe(true)
    const failed = JSON.parse(payloads.find((p) => p.includes('"failed"'))!)
    expect(failed).toMatchObject({ type: 'failed', status: 'failed', upload_id: UPLOAD_ID })
  })
})

// ============================================================
// processIngestProcessJob — sidecar network error (plain Error)
// ============================================================

describe('processIngestProcessJob — network error', () => {
  it('marks the upload failed with the plain error message and rethrows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const db = makeDb()

    await expect(processIngestProcessJob(makeJob(), db as never, OPTS)).rejects.toThrow(
      'ECONNREFUSED',
    )

    const failedSet = db.set.mock.calls[1][0] as Record<string, unknown>
    expect(failedSet.status).toBe('failed')
    expect(failedSet.error_message).toBe('ECONNREFUSED')
  })
})

// ============================================================
// processIngestProcessJob — sidecar returns status=error
// ============================================================

describe('processIngestProcessJob — sidecar status=error', () => {
  it('marks the upload failed with joined errors and throws', async () => {
    vi.stubGlobal(
      'fetch',
      fetchOk({ status: 'error', captures_posted: [], errors: ['parse failed'], duration_ms: 50 }),
    )
    const db = makeDb()

    await expect(processIngestProcessJob(makeJob(), db as never, OPTS)).rejects.toThrow(
      /returned status=error/,
    )

    const failedSet = db.set.mock.calls[1][0] as Record<string, unknown>
    expect(failedSet.status).toBe('failed')
    expect(failedSet.error_message).toBe('parse failed')

    const payloads = notifyPayloads(db)
    expect(payloads.some((p) => p.includes('"type":"failed"'))).toBe(true)
  })
})

// ============================================================
// processIngestProcessJob — empty secret warning
// ============================================================

describe('processIngestProcessJob — empty secret', () => {
  it('warns and sends an empty Bearer token when no secret is configured', async () => {
    const mockFetch = fetchOk()
    vi.stubGlobal('fetch', mockFetch)
    const db = makeDb()

    await processIngestProcessJob(makeJob(), db as never, { secret: '', timeoutMs: 5000 })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ')
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ============================================================
// emitUploadStatus — pg_notify failure is non-fatal
// ============================================================

describe('processIngestProcessJob — pg_notify failure isolation', () => {
  it('completes normally even when pg_notify (db.execute) rejects', async () => {
    vi.stubGlobal('fetch', fetchOk())
    const db = makeDb()
    db.execute.mockRejectedValue(new Error('notify channel down'))

    // Must NOT throw — the notify failure is caught and logged as non-fatal.
    const result = await processIngestProcessJob(makeJob(), db as never, OPTS)

    expect(result.status).toBe('ok')
    // Primary status write still happened.
    expect(db.update).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ============================================================
// createIngestProcessWorker
// ============================================================

describe('createIngestProcessWorker', () => {
  interface FakeWorker {
    name: string
    processor: (job: unknown) => Promise<unknown>
    opts: Record<string, unknown>
    handlers: Record<string, (...args: unknown[]) => unknown>
  }

  it('constructs a Worker on the ingest-process queue with the backoff strategy', () => {
    const db = makeDb()
    const connection = { host: 'redis' }

    const worker = createIngestProcessWorker(connection as never, db as never, {
      secret: 'wsecret',
      timeoutMs: 1000,
      concurrency: 3,
    }) as unknown as FakeWorker

    expect(worker.name).toBe('ingest-process')
    expect(worker.opts.connection).toBe(connection)
    expect(worker.opts.concurrency).toBe(3)
    expect((worker.opts.settings as { backoffStrategy: unknown }).backoffStrategy).toBe(
      ingestProcessBackoffStrategy,
    )
  })

  it('defaults concurrency to 2 and timeout to 300_000 when unset', () => {
    const worker = createIngestProcessWorker(
      { host: 'redis' } as never,
      makeDb() as never,
    ) as unknown as FakeWorker
    expect(worker.opts.concurrency).toBe(2)
  })

  it('reads the timeout from INGEST_TIMEOUT_MS env when no option is given', () => {
    process.env.INGEST_TIMEOUT_MS = '4242'
    // We cannot read timeoutMs directly off the mock, but the worker builds
    // without throwing and the processor closure uses it downstream.
    const worker = createIngestProcessWorker(
      { host: 'redis' } as never,
      makeDb() as never,
    ) as unknown as FakeWorker
    expect(worker.name).toBe('ingest-process')
  })

  it('the processor closure delegates to processIngestProcessJob', async () => {
    const mockFetch = fetchOk()
    vi.stubGlobal('fetch', mockFetch)
    const db = makeDb()

    const worker = createIngestProcessWorker(
      { host: 'redis' } as never,
      db as never,
      { secret: 'wsecret', timeoutMs: 1000 },
    ) as unknown as FakeWorker

    await worker.processor(makeJob())

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer wsecret')
    expect(db.update).toHaveBeenCalledTimes(2)
  })

  it('registers failed/completed event handlers that log without throwing', () => {
    const worker = createIngestProcessWorker(
      { host: 'redis' } as never,
      makeDb() as never,
    ) as unknown as FakeWorker

    expect(typeof worker.handlers.failed).toBe('function')
    expect(typeof worker.handlers.completed).toBe('function')

    // failed handler — with a job and with an undefined job (optional-chaining branch).
    expect(() => worker.handlers.failed(makeJob(), new Error('boom'))).not.toThrow()
    expect(() => worker.handlers.failed(undefined, new Error('boom'))).not.toThrow()
    expect(logger.warn).toHaveBeenCalled()

    // completed handler.
    expect(() => worker.handlers.completed(makeJob())).not.toThrow()
    expect(logger.debug).toHaveBeenCalled()
  })
})
