import { describe, it, expect, vi } from 'vitest'
import { ServiceUnavailableError } from '@open-brain/shared'
import { createApp } from '../app.js'
import type { EmailDraftService } from '../services/email-draft.js'
import type { EmailComposeAssistService } from '../services/email-compose-assist.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockEmailDraftService(): EmailDraftService {
  // compose-draft route doesn't use EmailDraftService, but app.ts requires it
  // to be present for registerEmailRoutes() to mount.
  return {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    send: vi.fn(),
    approveThenSend: vi.fn(),
  } as unknown as EmailDraftService
}

function makeMockComposeService(
  overrides: Partial<EmailComposeAssistService> = {},
): EmailComposeAssistService {
  return {
    compose: vi.fn().mockResolvedValue({
      body: 'Hi Alice,\n\nThanks for the note — I will follow up by Friday.\n\nTroy',
      subject: 'Follow-up',
    }),
    ...overrides,
  } as unknown as EmailComposeAssistService
}

// ---------------------------------------------------------------------------
// POST /api/v1/email/compose-draft
// ---------------------------------------------------------------------------

describe('POST /api/v1/email/compose-draft', () => {
  it('returns the proposed draft for a valid request', async () => {
    const emailDraftService = makeMockEmailDraftService()
    const emailComposeAssistService = makeMockComposeService()
    const app = createApp({ emailDraftService, emailComposeAssistService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({
        instruction: 'Reply to Alice about the Friday follow-up',
        existing_draft: {
          to: ['alice@example.com'],
          subject: 'Re: Friday',
        },
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.body).toContain('Alice')
    expect(body.subject).toBe('Follow-up')
    expect(emailComposeAssistService.compose).toHaveBeenCalledWith({
      instruction: 'Reply to Alice about the Friday follow-up',
      existingDraft: {
        to: ['alice@example.com'],
        subject: 'Re: Friday',
      },
    })
  })

  it('works without existing_draft', async () => {
    const emailDraftService = makeMockEmailDraftService()
    const emailComposeAssistService = makeMockComposeService()
    const app = createApp({ emailDraftService, emailComposeAssistService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({ instruction: 'Write a short thank-you note' }),
    })

    expect(res.status).toBe(200)
    expect(emailComposeAssistService.compose).toHaveBeenCalledWith({
      instruction: 'Write a short thank-you note',
      existingDraft: undefined,
    })
  })

  it('returns 400 when instruction is missing', async () => {
    const emailDraftService = makeMockEmailDraftService()
    const emailComposeAssistService = makeMockComposeService()
    const app = createApp({ emailDraftService, emailComposeAssistService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({ existing_draft: { subject: 'X' } }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when instruction is empty', async () => {
    const emailDraftService = makeMockEmailDraftService()
    const emailComposeAssistService = makeMockComposeService()
    const app = createApp({ emailDraftService, emailComposeAssistService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({ instruction: '' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON', async () => {
    const emailDraftService = makeMockEmailDraftService()
    const emailComposeAssistService = makeMockComposeService()
    const app = createApp({ emailDraftService, emailComposeAssistService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: 'not json',
    })

    expect(res.status).toBe(400)
  })

  it('returns 503 when the compose service is not wired', async () => {
    const emailDraftService = makeMockEmailDraftService()
    // emailComposeAssistService intentionally NOT passed
    const app = createApp({ emailDraftService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({ instruction: 'Draft something' }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('propagates 503 from ServiceUnavailableError thrown by the service', async () => {
    const emailDraftService = makeMockEmailDraftService()
    const emailComposeAssistService = makeMockComposeService({
      compose: vi
        .fn()
        .mockRejectedValue(
          new ServiceUnavailableError('AI compose is unavailable — ANTHROPIC_API_KEY is not configured'),
        ),
    })
    const app = createApp({ emailDraftService, emailComposeAssistService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({ instruction: 'Draft something' }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('returns 500 with safe message when the agent fails with an unknown error', async () => {
    const emailDraftService = makeMockEmailDraftService()
    const emailComposeAssistService = makeMockComposeService({
      compose: vi.fn().mockRejectedValue(new Error('AI compose failed — please try again or edit manually')),
    })
    const app = createApp({ emailDraftService, emailComposeAssistService })

    const res = await app.request('/api/v1/email/compose-draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({ instruction: 'Draft something' }),
    })

    expect(res.status).toBe(500)
    const body = await res.json() as any
    expect(body.code).toBe('COMPOSE_FAILED')
    expect(body.error).toBe('AI compose failed — please try again or edit manually')
    // Ensure we do NOT leak internal details like anthropic URLs, stack, or tool names
    expect(body.error).not.toContain('anthropic')
    expect(body.error).not.toContain('search_brain')
  })
})
