import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HimalayaService } from '../himalaya.js'

// ---------------------------------------------------------------------------
// Mock child_process.execFile
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

// ---------------------------------------------------------------------------
// Helper: simulate execFile callback behavior
// ---------------------------------------------------------------------------

function mockExecFileSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const child = {
      stdin: { write: vi.fn(), end: vi.fn() },
    }
    cb(null, stdout, stderr)
    return child
  })
}

function mockExecFileError(message: string, stderr = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const child = {
      stdin: { write: vi.fn(), end: vi.fn() },
    }
    cb(new Error(message), '', stderr)
    return child
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HimalayaService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor and isConfigured', () => {
    it('reads HIMALAYA_CONFIG from environment when not passed', () => {
      const original = process.env.HIMALAYA_CONFIG
      process.env.HIMALAYA_CONFIG = '/etc/himalaya/config.toml'

      const svc = new HimalayaService()
      expect(svc.isConfigured).toBe(true)

      // Restore
      if (original === undefined) delete process.env.HIMALAYA_CONFIG
      else process.env.HIMALAYA_CONFIG = original
    })

    it('returns false when no config path is set', () => {
      const original = process.env.HIMALAYA_CONFIG
      delete process.env.HIMALAYA_CONFIG

      const svc = new HimalayaService({ configPath: undefined })
      expect(svc.isConfigured).toBe(false)

      if (original !== undefined) process.env.HIMALAYA_CONFIG = original
    })

    it('uses provided config values', () => {
      const svc = new HimalayaService({
        binaryPath: '/custom/himalaya',
        configPath: '/custom/config.toml',
        timeoutMs: 5000,
      })
      expect(svc.isConfigured).toBe(true)
    })
  })

  describe('send()', () => {
    it('throws when HIMALAYA_CONFIG is not set', async () => {
      const original = process.env.HIMALAYA_CONFIG
      delete process.env.HIMALAYA_CONFIG

      const svc = new HimalayaService({ configPath: undefined })

      await expect(
        svc.send('test@example.com', 'Test Subject', 'Hello'),
      ).rejects.toThrow('HIMALAYA_CONFIG not set')

      if (original !== undefined) process.env.HIMALAYA_CONFIG = original
    })

    it('calls himalaya with correct args and pipes message to stdin', async () => {
      mockExecFileSuccess('Message sent')

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      const result = await svc.send('alice@example.com', 'Hello', 'Body text')

      expect(result.success).toBe(true)
      expect(result.output).toBe('Message sent')

      // Verify execFile was called with correct binary and args
      expect(mockExecFile).toHaveBeenCalledTimes(1)
      const [bin, args, opts] = mockExecFile.mock.calls[0]
      expect(bin).toBe('himalaya')
      expect(args).toEqual(['-c', '/etc/himalaya/config.toml', 'message', 'write'])
      expect(opts).toHaveProperty('timeout', 30_000)
    })

    it('includes CC header when cc option is provided', async () => {
      let capturedStdin = ''
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const child = {
          stdin: {
            write: vi.fn((data: string) => { capturedStdin = data }),
            end: vi.fn(),
          },
        }
        cb(null, 'sent', '')
        return child
      })

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      await svc.send('alice@example.com', 'Test', 'Body', { cc: 'bob@example.com' })

      expect(capturedStdin).toContain('Cc: bob@example.com')
      expect(capturedStdin).toContain('To: alice@example.com')
      expect(capturedStdin).toContain('Subject: Test')
    })

    it('includes Reply-To header when replyTo option is provided', async () => {
      let capturedStdin = ''
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const child = {
          stdin: {
            write: vi.fn((data: string) => { capturedStdin = data }),
            end: vi.fn(),
          },
        }
        cb(null, 'sent', '')
        return child
      })

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      await svc.send('alice@example.com', 'Test', 'Body', { replyTo: 'noreply@example.com' })

      expect(capturedStdin).toContain('Reply-To: noreply@example.com')
    })

    it('uses custom binary path', async () => {
      mockExecFileSuccess('sent')

      const svc = new HimalayaService({
        binaryPath: '/usr/local/bin/himalaya',
        configPath: '/etc/himalaya/config.toml',
      })

      await svc.send('test@example.com', 'Subj', 'Body')

      const [bin] = mockExecFile.mock.calls[0]
      expect(bin).toBe('/usr/local/bin/himalaya')
    })

    it('uses custom timeout', async () => {
      mockExecFileSuccess('sent')

      const svc = new HimalayaService({
        configPath: '/etc/himalaya/config.toml',
        timeoutMs: 5000,
      })

      await svc.send('test@example.com', 'Subj', 'Body')

      const [, , opts] = mockExecFile.mock.calls[0]
      expect(opts).toHaveProperty('timeout', 5000)
    })

    it('rejects when himalaya process errors', async () => {
      mockExecFileError('Connection refused', 'SMTP error: connection refused')

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      await expect(
        svc.send('test@example.com', 'Subj', 'Body'),
      ).rejects.toThrow('himalaya error: Connection refused')
    })

    it('includes stderr in error message when present', async () => {
      mockExecFileError('exit code 1', 'authentication failed')

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      await expect(
        svc.send('test@example.com', 'Subj', 'Body'),
      ).rejects.toThrow('stderr: authentication failed')
    })

    it('builds correct RFC 5322 message structure', async () => {
      let capturedStdin = ''
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const child = {
          stdin: {
            write: vi.fn((data: string) => { capturedStdin = data }),
            end: vi.fn(),
          },
        }
        cb(null, 'sent', '')
        return child
      })

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      await svc.send('alice@example.com', 'Important', 'Hello Alice,\n\nThis is a test.')

      // Headers before body, separated by blank line
      const headerBodySplit = capturedStdin.split('\r\n\r\n')
      expect(headerBodySplit.length).toBe(2)

      const headers = headerBodySplit[0]
      expect(headers).toContain('To: alice@example.com')
      expect(headers).toContain('Subject: Important')
      expect(headers).toContain('Content-Type: text/plain; charset=utf-8')

      const body = headerBodySplit[1]
      expect(body).toBe('Hello Alice,\n\nThis is a test.')
    })
  })

  describe('checkConnection()', () => {
    it('returns true when himalaya account check succeeds', async () => {
      mockExecFileSuccess('Account is valid')

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      const result = await svc.checkConnection()
      expect(result).toBe(true)

      const [, args] = mockExecFile.mock.calls[0]
      expect(args).toEqual(['-c', '/etc/himalaya/config.toml', 'account', 'check'])
    })

    it('returns false when himalaya account check fails', async () => {
      mockExecFileError('SMTP unreachable')

      const svc = new HimalayaService({ configPath: '/etc/himalaya/config.toml' })

      const result = await svc.checkConnection()
      expect(result).toBe(false)
    })

    it('returns false when config path is not set', async () => {
      const original = process.env.HIMALAYA_CONFIG
      delete process.env.HIMALAYA_CONFIG

      const svc = new HimalayaService({ configPath: undefined })

      const result = await svc.checkConnection()
      expect(result).toBe(false)

      expect(mockExecFile).not.toHaveBeenCalled()

      if (original !== undefined) process.env.HIMALAYA_CONFIG = original
    })
  })
})
