import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NotificationService } from '../services/notification.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('NotificationService', () => {
  const TOKEN = 'test-pushover-token'
  const USER = 'test-pushover-user'

  beforeEach(() => {
    vi.clearAllMocks()
    // Clear env vars that may affect constructor defaults
    delete process.env.PUSHOVER_TOKEN
    delete process.env.PUSHOVER_USER
  })

  afterEach(() => {
    delete process.env.PUSHOVER_TOKEN
    delete process.env.PUSHOVER_USER
  })

  describe('isConfigured', () => {
    it('returns true when token and user are provided in constructor', () => {
      const service = new NotificationService(TOKEN, USER)
      expect(service.isConfigured).toBe(true)
    })

    it('returns false when token is missing', () => {
      const service = new NotificationService(undefined, USER)
      expect(service.isConfigured).toBe(false)
    })

    it('returns false when user is missing', () => {
      const service = new NotificationService(TOKEN, undefined)
      expect(service.isConfigured).toBe(false)
    })

    it('returns false when both are missing', () => {
      const service = new NotificationService()
      expect(service.isConfigured).toBe(false)
    })

    it('reads token and user from env vars when not passed directly', () => {
      process.env.PUSHOVER_TOKEN = TOKEN
      process.env.PUSHOVER_USER = USER
      const service = new NotificationService()
      expect(service.isConfigured).toBe(true)
    })
  })

  describe('send', () => {
    it('skips sending when not configured — no fetch call', async () => {
      const service = new NotificationService()

      await service.send({ title: 'Test', message: 'Hello' })

      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('POSTs to Pushover API with correct URL and headers', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.send({ title: 'Test title', message: 'Test message' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.pushover.net/1/messages.json')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    })

    it('includes token, user, title, and message in request body', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.send({ title: 'Alert title', message: 'Alert body' })

      const [, opts] = mockFetch.mock.calls[0]
      const body = opts.body as string
      expect(body).toContain(`token=${TOKEN}`)
      expect(body).toContain(`user=${USER}`)
      expect(body).toContain('title=Alert+title')
      expect(body).toContain('message=Alert+body')
    })

    it('defaults priority to -1 (low) when not specified', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.send({ title: 'T', message: 'M' })

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.body).toContain('priority=-1')
    })

    it('uses specified priority value', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.send({ title: 'Urgent', message: 'Help', priority: 1 })

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.body).toContain('priority=1')
    })

    it('includes url and url_title when provided', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.send({
        title: 'Link',
        message: 'Click here',
        url: 'https://example.com',
        url_title: 'Open',
      })

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.body).toContain('url=https')
      expect(opts.body).toContain('url_title=Open')
    })

    it('does not throw when Pushover returns non-ok status — logs warning only', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      })

      // Should not throw
      await expect(service.send({ title: 'T', message: 'M' })).resolves.toBeUndefined()
    })

    it('does not throw when fetch itself fails — swallows network errors', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      // Should not propagate — notification failures are non-fatal
      await expect(service.send({ title: 'T', message: 'M' })).resolves.toBeUndefined()
    })
  })

  describe('notifyCaptureSuccess', () => {
    it('sends a notification with title "Voice memo captured"', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.notifyCaptureSuccess({
        captureId: 'cap-123',
        captureType: 'idea',
        brainView: 'technical',
        topics: 'AI, TypeScript',
        snippet: 'I have an idea about automated testing',
      })

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.body).toContain('title=Voice+memo+captured')
    })

    it('includes captureType and brainView in the message body', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.notifyCaptureSuccess({
        captureId: 'cap-456',
        captureType: 'decision',
        brainView: 'work-internal',
        topics: 'architecture',
        snippet: 'We decided to use Drizzle ORM',
      })

      const [, opts] = mockFetch.mock.calls[0]
      // URLSearchParams decode both %xx and + (application/x-www-form-urlencoded)
      const params = new URLSearchParams(opts.body as string)
      const message = params.get('message') ?? ''
      expect(message).toContain('decision')
      expect(message).toContain('work-internal')
    })

    it('includes topics when present', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.notifyCaptureSuccess({
        captureId: 'cap-789',
        captureType: 'idea',
        brainView: 'personal',
        topics: 'AI, knowledge management',
        snippet: 'A new idea',
      })

      const [, opts] = mockFetch.mock.calls[0]
      const params = new URLSearchParams(opts.body as string)
      const message = params.get('message') ?? ''
      expect(message).toContain('AI, knowledge management')
    })

    it('omits topics line when topics is empty', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.notifyCaptureSuccess({
        captureId: 'cap-000',
        captureType: 'observation',
        brainView: 'personal',
        topics: '',
        snippet: 'Something I noticed',
      })

      const [, opts] = mockFetch.mock.calls[0]
      const params = new URLSearchParams(opts.body as string)
      const message = params.get('message') ?? ''
      expect(message).not.toContain('Topics:')
    })

    it('appends ellipsis to snippet when it is 120 chars', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      // Exactly 120 chars
      const longSnippet = 'A'.repeat(120)

      await service.notifyCaptureSuccess({
        captureId: 'cap-001',
        captureType: 'idea',
        brainView: 'personal',
        topics: '',
        snippet: longSnippet,
      })

      const [, opts] = mockFetch.mock.calls[0]
      const body = decodeURIComponent(opts.body as string)
      expect(body).toContain('…')
    })

    it('does not append ellipsis when snippet is shorter than 120 chars', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      const shortSnippet = 'Short snippet'

      await service.notifyCaptureSuccess({
        captureId: 'cap-002',
        captureType: 'idea',
        brainView: 'personal',
        topics: '',
        snippet: shortSnippet,
      })

      const [, opts] = mockFetch.mock.calls[0]
      const body = decodeURIComponent(opts.body as string)
      expect(body).not.toContain('…')
    })

    it('skips sending when not configured', async () => {
      const service = new NotificationService()

      await service.notifyCaptureSuccess({
        captureId: 'cap-skip',
        captureType: 'idea',
        brainView: 'personal',
        topics: 'test',
        snippet: 'test',
      })

      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('uses low priority (-1) for capture success notifications', async () => {
      const service = new NotificationService(TOKEN, USER)
      mockFetch.mockResolvedValueOnce({ ok: true })

      await service.notifyCaptureSuccess({
        captureId: 'cap-pri',
        captureType: 'win',
        brainView: 'personal',
        topics: '',
        snippet: 'We won a contract',
      })

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.body).toContain('priority=-1')
    })
  })
})
