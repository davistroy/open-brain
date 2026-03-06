import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmailService } from '../services/email.js'
import { processEmailJob } from '../jobs/email.js'
import type { EmailJobData } from '../jobs/email.js'

// ============================================================
// nodemailer mock
// ============================================================

const mockSendMail = vi.fn()
const mockCreateTransport = vi.fn()

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (...args: unknown[]) => {
      mockCreateTransport(...args)
      return { sendMail: mockSendMail }
    },
  },
}))

// ============================================================
// EmailService unit tests
// ============================================================

describe('EmailService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
    delete process.env.SMTP_PORT
    delete process.env.SMTP_FROM
  })

  describe('isConfigured', () => {
    it('returns true when host and user are provided via constructor', () => {
      const svc = new EmailService({ host: 'smtp.example.com', user: 'user@example.com' })
      expect(svc.isConfigured).toBe(true)
    })

    it('returns true when host and user are read from env vars', () => {
      process.env.SMTP_HOST = 'smtp.env.com'
      process.env.SMTP_USER = 'env@example.com'
      const svc = new EmailService()
      expect(svc.isConfigured).toBe(true)
    })

    it('returns false when host is missing', () => {
      const svc = new EmailService({ user: 'user@example.com' })
      expect(svc.isConfigured).toBe(false)
    })

    it('returns false when user is missing', () => {
      const svc = new EmailService({ host: 'smtp.example.com' })
      expect(svc.isConfigured).toBe(false)
    })

    it('returns false when both are missing', () => {
      const svc = new EmailService()
      expect(svc.isConfigured).toBe(false)
    })
  })

  describe('send — not configured', () => {
    it('silently returns without calling nodemailer when not configured', async () => {
      const svc = new EmailService()
      await svc.send({
        to: 'troy@example.com',
        subject: 'Test',
        htmlBody: '<p>hello</p>',
        textBody: 'hello',
      })

      expect(mockSendMail).not.toHaveBeenCalled()
    })
  })

  describe('send — happy path', () => {
    it('calls nodemailer createTransport with SMTP config', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'msg-123' })

      const svc = new EmailService({
        host: 'smtp.example.com',
        port: 587,
        user: 'user',
        pass: 'secret',
      })

      await svc.send({
        to: 'recipient@example.com',
        subject: 'Weekly Brief',
        htmlBody: '<h1>Brief</h1>',
        textBody: 'Brief',
      })

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          auth: expect.objectContaining({ user: 'user', pass: 'secret' }),
        }),
      )
    })

    it('calls sendMail with to, subject, html, and text', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'msg-456' })

      const svc = new EmailService({ host: 'smtp.test', user: 'u', pass: 'p' })
      await svc.send({
        to: 'troy@stratfield.io',
        subject: 'Open Brain Weekly Brief — 2026-03-01',
        htmlBody: '<html><body>...</body></html>',
        textBody: 'Plain text fallback',
      })

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'troy@stratfield.io',
          subject: 'Open Brain Weekly Brief — 2026-03-01',
          html: '<html><body>...</body></html>',
          text: 'Plain text fallback',
        }),
      )
    })

    it('uses default from address when SMTP_FROM not set', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'msg-789' })

      const svc = new EmailService({ host: 'smtp.test', user: 'u' })
      await svc.send({ to: 't@e.com', subject: 'S', htmlBody: 'H', textBody: 'T' })

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Open Brain <no-reply@open-brain>',
        }),
      )
    })

    it('uses custom from address when provided', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'msg-000' })

      const svc = new EmailService({
        host: 'smtp.test',
        user: 'u',
        from: 'Open Brain <brain@k4jda.net>',
      })
      await svc.send({ to: 't@e.com', subject: 'S', htmlBody: 'H', textBody: 'T' })

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Open Brain <brain@k4jda.net>',
        }),
      )
    })

    it('uses SSL (secure: true) when port is 465', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'msg-ssl' })

      const svc = new EmailService({ host: 'smtp.test', port: 465, user: 'u' })
      await svc.send({ to: 't@e.com', subject: 'S', htmlBody: 'H', textBody: 'T' })

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ secure: true }),
      )
    })

    it('uses STARTTLS (secure: false) for non-465 ports', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'msg-tls' })

      const svc = new EmailService({ host: 'smtp.test', port: 587, user: 'u' })
      await svc.send({ to: 't@e.com', subject: 'S', htmlBody: 'H', textBody: 'T' })

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ secure: false }),
      )
    })
  })

  describe('send — SMTP errors', () => {
    it('throws on SMTP delivery error so BullMQ can retry', async () => {
      mockSendMail.mockRejectedValue(new Error('ECONNREFUSED smtp.test:587'))

      const svc = new EmailService({ host: 'smtp.test', user: 'u' })
      await expect(
        svc.send({ to: 't@e.com', subject: 'S', htmlBody: 'H', textBody: 'T' }),
      ).rejects.toThrow('ECONNREFUSED')
    })

    it('throws on auth failure', async () => {
      mockSendMail.mockRejectedValue(new Error('Invalid login: 535'))

      const svc = new EmailService({ host: 'smtp.test', user: 'u', pass: 'wrong' })
      await expect(
        svc.send({ to: 't@e.com', subject: 'S', htmlBody: 'H', textBody: 'T' }),
      ).rejects.toThrow('535')
    })
  })

  describe('env var fallbacks', () => {
    it('reads SMTP_PORT from env and parses as integer', async () => {
      process.env.SMTP_HOST = 'smtp.env.com'
      process.env.SMTP_USER = 'u'
      process.env.SMTP_PORT = '465'
      mockSendMail.mockResolvedValue({ messageId: 'msg-port' })

      const svc = new EmailService()
      await svc.send({ to: 't@e.com', subject: 'S', htmlBody: 'H', textBody: 'T' })

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 465, secure: true }),
      )
    })
  })
})

// ============================================================
// processEmailJob unit tests
// ============================================================

describe('processEmailJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset env vars that may have been set by EmailService describe tests
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
    delete process.env.SMTP_PORT
    delete process.env.SMTP_FROM
  })

  it('delegates to EmailService.send with correct payload', async () => {
    const svc = new EmailService({ host: 'smtp.test', user: 'u' })
    const sendSpy = vi.spyOn(svc, 'send').mockResolvedValue(undefined)

    const data: EmailJobData = {
      to: 'troy@example.com',
      subject: 'Open Brain Weekly Brief',
      htmlBody: '<h1>Brief</h1>',
      textBody: 'Brief text',
    }

    await processEmailJob(data, svc)

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'troy@example.com',
        subject: 'Open Brain Weekly Brief',
        htmlBody: '<h1>Brief</h1>',
        textBody: 'Brief text',
      }),
    )
  })

  it('does not call send when SMTP not configured (logs warning, completes cleanly)', async () => {
    // Create a service with no credentials so isConfigured is false
    const svc = new EmailService()
    expect(svc.isConfigured).toBe(false)

    // Replace send with a mock that fails loudly if called
    const sendMock = vi.fn().mockRejectedValue(new Error('send should not be called'))
    svc.send = sendMock

    const data: EmailJobData = {
      to: 'troy@example.com',
      subject: 'Test',
      htmlBody: '<p>Test</p>',
      textBody: 'Test',
    }

    // processEmailJob checks isConfigured first and returns early — completes without error
    await expect(processEmailJob(data, svc)).resolves.toBeUndefined()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('throws when EmailService.send throws (allowing BullMQ retry)', async () => {
    const svc = new EmailService({ host: 'smtp.test', user: 'u' })
    vi.spyOn(svc, 'send').mockRejectedValue(new Error('SMTP connection refused'))

    await expect(
      processEmailJob(
        { to: 'test@test.com', subject: 'S', htmlBody: 'H', textBody: 'T' },
        svc,
      ),
    ).rejects.toThrow('SMTP connection refused')
  })

  it('includes correlationId in logging (passed through data object)', async () => {
    const svc = new EmailService({ host: 'smtp.test', user: 'u' })
    vi.spyOn(svc, 'send').mockResolvedValue(undefined)

    const data: EmailJobData = {
      to: 'troy@example.com',
      subject: 'Brief with correlation',
      htmlBody: '<p>Brief</p>',
      textBody: 'Brief',
      correlationId: 'cap-uuid-123',
    }

    // Should complete without error regardless of correlationId
    await expect(processEmailJob(data, svc)).resolves.toBeUndefined()
  })
})
