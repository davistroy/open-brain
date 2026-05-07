import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotFoundError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Infrastructure mocks (required by health.ts and always-loaded routes)
// ---------------------------------------------------------------------------
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.stubGlobal('fetch', vi.fn())

import { createApp } from '../app.js'
import type { BriefsService } from '../services/briefs.js'
import type { TtsDeps, TtsRedisClient } from '../routes/briefs.js'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_BRIEF_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const SAMPLE_BRIEF = {
  id: SAMPLE_BRIEF_ID,
  kind: 'DAILY',
  cover: 'morning',
  title: 'Morning Brief — April 22',
  subtitle: null,
  source_skill_log_id: null,
  refined_from_id: null,
  body_html: '<h2>Today\'s Highlights</h2><p>Three key decisions were made. The team &amp; stakeholders aligned on Q2 priorities.</p><ul><li>Item one</li><li>Item two</li></ul>',
  toc: [],
  sources: [],
  refine_options: ['Focus on recent'],
  generated_at: '2026-04-22T06:00:00.000Z',
  read_at: null,
  dismissed_at: null,
  created_at: '2026-04-22T06:00:00.000Z',
  updated_at: '2026-04-22T06:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockBriefsService(overrides: Partial<BriefsService> = {}): BriefsService {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
    getById: vi.fn().mockResolvedValue(SAMPLE_BRIEF),
    create: vi.fn().mockResolvedValue(SAMPLE_BRIEF),
    refine: vi.fn().mockResolvedValue({ job_id: 'job-1', status: 'queued' }),
    dismiss: vi.fn().mockResolvedValue(undefined),
    patchRead: vi.fn().mockResolvedValue(SAMPLE_BRIEF),
    ...overrides,
  } as unknown as BriefsService
}

function makeMockRedis(cachedBuffer: Buffer | null = null): TtsRedisClient {
  return {
    getBuffer: vi.fn().mockResolvedValue(cachedBuffer),
    setex: vi.fn().mockResolvedValue('OK'),
  }
}

function makeMockDb() {
  const insertValuesMock = vi.fn().mockResolvedValue([{}])
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock })

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue([]),
          }),
          then: (onfulfilled: (v: unknown) => unknown) =>
            Promise.resolve([{ total: '0' }]).then(onfulfilled),
        }),
      }),
    }),
    insert: insertMock,
    _insertValuesMock: insertValuesMock,
  }
}

function makeTtsDeps(overrides: Partial<TtsDeps> = {}): TtsDeps {
  return {
    db: makeMockDb() as unknown as TtsDeps['db'],
    redis: makeMockRedis(),
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: 'sk-test-key',
    ...overrides,
  }
}

/** Mock a successful OpenAI TTS API response returning an audio buffer */
function mockSuccessfulTtsResponse(audioData: Buffer = Buffer.from('FAKE_MP3_AUDIO')): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: vi.fn().mockResolvedValue(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Mock a failed OpenAI TTS API response */
function mockFailedTtsResponse(status = 500, body = 'Internal Server Error'): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// ---------------------------------------------------------------------------
// POST /api/v1/briefs/:id/audio — 503 when ttsDeps absent
// ---------------------------------------------------------------------------

describe('POST /api/v1/briefs/:id/audio — no TTS deps', () => {
  it('returns 503 when ttsDeps not provided', async () => {
    const briefsService = makeMockBriefsService()
    const app = createApp({ briefsService })

    const res = await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    expect(res.status).toBe(503)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/briefs/:id/audio — 404 on missing brief
// ---------------------------------------------------------------------------

describe('POST /api/v1/briefs/:id/audio — brief not found', () => {
  it('returns 404 for nonexistent brief', async () => {
    const missingId = '99999999-9999-9999-9999-999999999999'
    const briefsService = makeMockBriefsService({
      getById: vi.fn().mockRejectedValue(new NotFoundError(`Brief not found: ${missingId}`)),
    })
    const ttsDeps = makeTtsDeps()
    const app = createApp({ briefsService, ttsDeps })

    const res = await app.request(`/api/v1/briefs/${missingId}/audio`, { method: 'POST' })

    expect(res.status).toBe(404)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/briefs/:id/audio — cache hit path
// ---------------------------------------------------------------------------

describe('POST /api/v1/briefs/:id/audio — Redis cache hit', () => {
  beforeEach(() => {
    // Ensure global fetch is not called when cache hits
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('should not be called')))
  })

  it('returns cached audio without calling OpenAI', async () => {
    const cachedAudio = Buffer.from('CACHED_MP3_AUDIO')
    const redis = makeMockRedis(cachedAudio)
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ redis })
    const app = createApp({ briefsService, ttsDeps })

    const res = await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(res.headers.get('X-TTS-Cache')).toBe('hit')

    // OpenAI fetch must NOT have been called
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()

    // Redis getBuffer called with correct key
    expect(redis.getBuffer).toHaveBeenCalledWith(`tts:${SAMPLE_BRIEF_ID}:alloy`)

    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf).toEqual(cachedAudio)
  })

  it('uses ?voice param in cache key', async () => {
    const cachedAudio = Buffer.from('CACHED_NOVA_AUDIO')
    const redis = makeMockRedis(cachedAudio)
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ redis })
    const app = createApp({ briefsService, ttsDeps })

    const res = await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio?voice=nova`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(redis.getBuffer).toHaveBeenCalledWith(`tts:${SAMPLE_BRIEF_ID}:nova`)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/briefs/:id/audio — cache miss path (live OpenAI call)
// ---------------------------------------------------------------------------

describe('POST /api/v1/briefs/:id/audio — cache miss (live TTS)', () => {
  it('calls OpenAI TTS and returns audio/mpeg on success', async () => {
    const fakeAudio = Buffer.from('FAKE_GENERATED_MP3')
    const fetchMock = mockSuccessfulTtsResponse(fakeAudio)
    const redis = makeMockRedis(null)
    const db = makeMockDb()
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ redis, db: db as unknown as TtsDeps['db'] })
    const app = createApp({ briefsService, ttsDeps })

    const res = await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(res.headers.get('X-TTS-Cache')).toBe('miss')

    // OpenAI TTS called once
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/audio/speech')
    expect(opts.method).toBe('POST')
    const reqBody = JSON.parse(opts.body as string) as { model: string; voice: string; response_format: string; input: string }
    expect(reqBody.model).toBe('tts-1')
    expect(reqBody.voice).toBe('alloy')
    expect(reqBody.response_format).toBe('mp3')
    // body_html stripped to plain text
    expect(reqBody.input).toContain("Today's Highlights")
    expect(reqBody.input).not.toContain('<h2>')
    // HTML entities decoded
    expect(reqBody.input).toContain('team & stakeholders')
  })

  it('stores generated audio in Redis cache with TTL 86400', async () => {
    const fakeAudio = Buffer.from('FAKE_GENERATED_MP3')
    mockSuccessfulTtsResponse(fakeAudio)
    const redis = makeMockRedis(null)
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ redis })
    const app = createApp({ briefsService, ttsDeps })

    await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    expect(redis.setex).toHaveBeenCalledWith(
      `tts:${SAMPLE_BRIEF_ID}:alloy`,
      86400,
      expect.any(Buffer),
    )
  })

  it('records cost in ai_audit_log', async () => {
    const fakeAudio = Buffer.from('FAKE_MP3')
    mockSuccessfulTtsResponse(fakeAudio)
    const redis = makeMockRedis(null)
    const db = makeMockDb()
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ redis, db: db as unknown as TtsDeps['db'] })
    const app = createApp({ briefsService, ttsDeps })

    await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    expect(db.insert).toHaveBeenCalledTimes(1)
    // values() receives the audit row
    const auditRow = db._insertValuesMock.mock.calls[0][0] as {
      task_type: string
      model: string
      client_used: string
      cost_usd: string
      prompt_tokens: number
    }
    expect(auditRow.task_type).toBe('tts')
    expect(auditRow.model).toBe('tts-1')
    expect(auditRow.client_used).toBe('openai')
    expect(parseFloat(auditRow.cost_usd)).toBeGreaterThan(0)
    expect(auditRow.prompt_tokens).toBeGreaterThan(0)
  })

  it('returns 502 when OpenAI TTS API call fails', async () => {
    mockFailedTtsResponse(500, 'TTS service error')
    const redis = makeMockRedis(null)
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ redis })
    const app = createApp({ briefsService, ttsDeps })

    const res = await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    expect(res.status).toBe(502)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('TTS_ERROR')
  })

  it('handles non-alloy voice param correctly', async () => {
    const fakeAudio = Buffer.from('SHIMMER_AUDIO')
    const fetchMock = mockSuccessfulTtsResponse(fakeAudio)
    const redis = makeMockRedis(null)
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ redis })
    const app = createApp({ briefsService, ttsDeps })

    const res = await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio?voice=shimmer`, { method: 'POST' })

    expect(res.status).toBe(200)
    const reqBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { voice: string }
    expect(reqBody.voice).toBe('shimmer')
    expect(redis.setex).toHaveBeenCalledWith(`tts:${SAMPLE_BRIEF_ID}:shimmer`, 86400, expect.any(Buffer))
  })

  it('rejects invalid voice param with 400', async () => {
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps()
    const app = createApp({ briefsService, ttsDeps })

    const res = await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio?voice=badvoice`, { method: 'POST' })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/briefs/:id/audio — base URL construction
// ---------------------------------------------------------------------------

describe('POST /api/v1/briefs/:id/audio — OpenAI URL construction', () => {
  it('appends /audio/speech to base URL ending in /v1', async () => {
    const fetchMock = mockSuccessfulTtsResponse()
    const briefsService = makeMockBriefsService()
    const ttsDeps = makeTtsDeps({ openaiBaseUrl: 'https://api.openai.com/v1' })
    const app = createApp({ briefsService, ttsDeps })

    await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
  })

  it('adds /v1/audio/speech when base URL lacks the /v1 suffix', async () => {
    const fetchMock = mockSuccessfulTtsResponse()
    const briefsService = makeMockBriefsService()
    // Base URL without /v1 (non-standard config)
    const ttsDeps = makeTtsDeps({ openaiBaseUrl: 'https://api.openai.com' })
    const app = createApp({ briefsService, ttsDeps })

    await app.request(`/api/v1/briefs/${SAMPLE_BRIEF_ID}/audio`, { method: 'POST' })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
  })
})
