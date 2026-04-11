import { execFile } from 'node:child_process'
import { createLogger } from '../lib/logger.js'

const logger = createLogger('himalaya')

const DEFAULT_TIMEOUT_MS = 30_000

export interface HimalayaSendOptions {
  /** CC recipients (comma-separated) */
  cc?: string
  /** Reply-To address */
  replyTo?: string
}

export interface HimalayaSendResult {
  /** Whether the send succeeded */
  success: boolean
  /** Raw stdout from himalaya (may contain message ID) */
  output: string
}

export interface HimalayaServiceConfig {
  /** Path to himalaya binary. Default: 'himalaya' (uses PATH) */
  binaryPath?: string
  /** Path to himalaya TOML config file. Default: env HIMALAYA_CONFIG */
  configPath?: string
  /** Timeout for CLI execution in ms. Default: 30000 */
  timeoutMs?: number
}

/**
 * Wrapper around the himalaya CLI for outbound email via SMTP.
 *
 * Himalaya is a Rust CLI email client that supports SMTP sending without
 * requiring a running mail server process. Configuration (SMTP host, port,
 * credentials) lives in a TOML config file referenced by `configPath`.
 *
 * This service only handles outbound sending — inbound email is handled by
 * the Cloudflare Email Worker (brain@troy-davis.com).
 */
export class HimalayaService {
  private binaryPath: string
  private configPath: string | undefined
  private timeoutMs: number

  constructor(config?: HimalayaServiceConfig) {
    this.binaryPath = config?.binaryPath ?? 'himalaya'
    this.configPath = config?.configPath ?? process.env.HIMALAYA_CONFIG
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Whether the service has a config path set (minimum viable configuration).
   */
  get isConfigured(): boolean {
    return Boolean(this.configPath)
  }

  /**
   * Send an email via himalaya's SMTP backend.
   *
   * Composes a minimal RFC 5322 message and pipes it to `himalaya message write`
   * which sends via the configured SMTP account.
   */
  async send(
    to: string,
    subject: string,
    body: string,
    options?: HimalayaSendOptions,
  ): Promise<HimalayaSendResult> {
    if (!this.configPath) {
      throw new Error('HimalayaService: HIMALAYA_CONFIG not set — cannot send email')
    }

    // Build RFC 5322 message
    const headers: string[] = [
      `To: ${to}`,
      `Subject: ${subject}`,
    ]
    if (options?.cc) {
      headers.push(`Cc: ${options.cc}`)
    }
    if (options?.replyTo) {
      headers.push(`Reply-To: ${options.replyTo}`)
    }
    headers.push('Content-Type: text/plain; charset=utf-8')
    headers.push('')  // blank line separates headers from body
    headers.push(body)

    const message = headers.join('\r\n')

    const args = ['-c', this.configPath, 'message', 'write']

    logger.debug({ to, subject, cc: options?.cc }, 'sending email via himalaya')

    const output = await this.exec(args, message)

    logger.info({ to, subject }, 'email sent successfully')

    return { success: true, output }
  }

  /**
   * Verify SMTP connectivity by running `himalaya account check`.
   * Returns true if the SMTP connection is reachable, false otherwise.
   */
  async checkConnection(): Promise<boolean> {
    if (!this.configPath) {
      logger.debug('HIMALAYA_CONFIG not set — skipping connection check')
      return false
    }

    try {
      await this.exec(['-c', this.configPath, 'account', 'check'])
      logger.info('SMTP connection check passed')
      return true
    } catch (err) {
      logger.warn({ err }, 'SMTP connection check failed')
      return false
    }
  }

  /**
   * Execute the himalaya binary with given args. Optionally pipe stdin data.
   */
  private exec(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.binaryPath,
        args,
        { timeout: this.timeoutMs },
        (error, stdout, stderr) => {
          if (error) {
            const msg = `himalaya error: ${error.message}${stderr ? ` — stderr: ${stderr}` : ''}`
            logger.error({ error, stderr, args: args.join(' ') }, msg)
            reject(new Error(msg))
            return
          }
          if (stderr) {
            logger.debug({ stderr }, 'himalaya stderr (non-fatal)')
          }
          resolve(stdout.trim())
        },
      )

      if (stdin && child.stdin) {
        child.stdin.write(stdin)
        child.stdin.end()
      }
    })
  }
}
