import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import type { EmailDraftService } from '../services/email-draft.js'

// ---------------------------------------------------------------------------
// Mock EmailDraftService
// ---------------------------------------------------------------------------

const SAMPLE_DRAFT = {
  id: 'draft-uuid-1',
  to_address: 'test@example.com',
  cc_address: null,
  subject: 'Test Subject',
  body: 'Test body content',
  status: 'draft',
  send_mode: 'review-required',
  source: 'api',
  approved_at: null,
  sent_at: null,
  himalaya_message_id: null,
  capture_id: null,
  metadata: null,
  created_at: new Date('2026-04-11T00:00:00Z'),
  updated_at: new Date('2026-04-11T00:00:00Z'),
}

const SENT_DRAFT = {
  ...SAMPLE_DRAFT,
  status: 'sent',
  sent_at: new Date('2026-04-11T01:00:00Z'),
}

const REJECTED_DRAFT = {
  ...SAMPLE_DRAFT,
  status: 'rejected',
}

function makeMockService(overrides: Partial<EmailDraftService> = {}): EmailDraftService {
  return {
    create: vi.fn().mockResolvedValue(SAMPLE_DRAFT),
    list: vi.fn().mockResolvedValue({ items: [SAMPLE_DRAFT], total: 1 }),
    get: vi.fn().mockResolvedValue(SAMPLE_DRAFT),
    approve: vi.fn().mockResolvedValue({ ...SAMPLE_DRAFT, status: 'approved' }),
    reject: vi.fn().mockResolvedValue(REJECTED_DRAFT),
    send: vi.fn().mockResolvedValue(SENT_DRAFT),
    approveThenSend: vi.fn().mockResolvedValue(SENT_DRAFT),
    ...overrides,
  } as unknown as EmailDraftService
}

// ---------------------------------------------------------------------------
// GET /api/v1/email/drafts
// ---------------------------------------------------------------------------

describe('GET /api/v1/email/drafts', () => {
  it('returns paginated draft list with defaults', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe('draft-uuid-1')
    expect(body.total).toBe(1)
    expect(body.limit).toBe(50)
    expect(body.offset).toBe(0)
    expect(emailDraftService.list).toHaveBeenCalledWith(undefined, 50, 0)
  })

  it('passes status filter', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    await app.request('/api/v1/email/drafts?status=draft&limit=10&offset=5')

    expect(emailDraftService.list).toHaveBeenCalledWith('draft', 10, 5)
  })

  it('returns 400 for invalid status', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts?status=bogus')

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('caps limit at 100', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    await app.request('/api/v1/email/drafts?limit=500')

    expect(emailDraftService.list).toHaveBeenCalledWith(undefined, 100, 0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/email/drafts/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/email/drafts/:id', () => {
  it('returns a single draft', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts/draft-uuid-1')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe('draft-uuid-1')
    expect(emailDraftService.get).toHaveBeenCalledWith('draft-uuid-1')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/email/drafts
// ---------------------------------------------------------------------------

describe('POST /api/v1/email/drafts', () => {
  it('creates a draft with required fields', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'recipient@example.com',
        subject: 'Test',
        body: 'Hello world',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.id).toBe('draft-uuid-1')
    expect(body.status).toBe('draft')
    expect(emailDraftService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recipient@example.com',
        subject: 'Test',
        body: 'Hello world',
      }),
    )
  })

  it('returns 400 when to is missing', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Test', body: 'Hello' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when subject is missing', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'a@b.com', body: 'Hello' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 when body is missing', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'a@b.com', subject: 'Test' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid sendMode', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Test',
        body: 'Hello',
        sendMode: 'invalid-mode',
      }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(res.status).toBe(400)
  })

  it('passes optional fields through', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    await app.request('/api/v1/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Test',
        body: 'Hello',
        cc: 'cc@example.com',
        source: 'mcp',
        sendMode: 'auto-send',
        metadata: { context: 'test' },
      }),
    })

    expect(emailDraftService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: 'cc@example.com',
        source: 'mcp',
        sendMode: 'auto-send',
        metadata: { context: 'test' },
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/email/drafts/:id/send
// ---------------------------------------------------------------------------

describe('POST /api/v1/email/drafts/:id/send', () => {
  it('approves and sends the draft', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts/draft-uuid-1/send', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe('sent')
    expect(body.sent_at).toBeDefined()
    expect(emailDraftService.approveThenSend).toHaveBeenCalledWith('draft-uuid-1')
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/email/drafts/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/email/drafts/:id', () => {
  it('rejects the draft', async () => {
    const emailDraftService = makeMockService()
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/drafts/draft-uuid-1', {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe('rejected')
    expect(emailDraftService.reject).toHaveBeenCalledWith('draft-uuid-1')
  })
})
