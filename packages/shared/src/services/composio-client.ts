/**
 * Lightweight Composio MCP client for batch scripts and workers.
 *
 * Calls the Composio Streamable HTTP MCP endpoint to execute pre-built
 * integrations (Gmail, Outlook Calendar, Drive, Sheets, Notion, Slack).
 *
 * Usage (string form — backward compat):
 *   const client = new ComposioClient(apiKey)
 *   const events = await client.execute('OUTLOOK_GET_CALENDAR_VIEW', { ... })
 *
 * Usage (options form — with quota meter):
 *   const client = new ComposioClient({ apiKey, redis, pushover })
 *   const events = await client.execute('OUTLOOK_GET_CALENDAR_VIEW', { ... })
 *
 * Requires: COMPOSIO_API_KEY env var or constructor param.
 * API key stored in Bitwarden as OPENCLAW_COMPOSIO_API_KEY.
 *
 * Quota enforcement (P03):
 * - When redis is injected, every execute() call increments a monthly Redis counter.
 * - Hard stop throws ComposioQuotaExceededError at 19,000 calls (95% of 20K free tier).
 * - Pushover warning fires at 15,000 calls (75%).
 * - Without redis injection, execute() proceeds with no quota tracking (backward compat).
 */

import { createLogger } from '../lib/logger.js'
import type { PushoverService } from './pushover.js'

const logger = createLogger('composio')

const COMPOSIO_URL = 'https://connect.composio.dev/mcp'

/** Hard-stop threshold: throw ComposioQuotaExceededError when count exceeds this. */
const COMPOSIO_MONTHLY_HARD_STOP = 19_000

/** Warn threshold: send Pushover alert when count exactly equals this.
 * Note: concurrent calls at the boundary may miss the exact value — best-effort. */
const COMPOSIO_WARN_THRESHOLD = 15_000

/**
 * Thrown when the Composio monthly quota hard stop is reached.
 * Hard stop is at 19,000 calls — 95% of the 20,000 free tier.
 */
export class ComposioQuotaExceededError extends Error {
  constructor(count: number) {
    super(
      `Composio monthly quota hard stop: ${count} calls used (limit: ${COMPOSIO_MONTHLY_HARD_STOP}). ` +
        'No further Composio calls this month.',
    )
    this.name = 'ComposioQuotaExceededError'
  }
}

/**
 * Duck-typed Redis subset for quota tracking.
 * Any ioredis client satisfies this interface — avoids adding ioredis as a
 * runtime dependency of @open-brain/shared.
 */
export interface ComposioRedisClient {
  incr: (key: string) => Promise<number>
  expire: (key: string, seconds: number) => Promise<unknown>
}

/**
 * Options form for ComposioClient constructor — enables quota meter injection.
 */
export interface ComposioClientOptions {
  apiKey?: string
  /** Optional Redis client for monthly quota counting. When omitted, no quota is enforced. */
  redis?: ComposioRedisClient
  /** Optional Pushover service for quota warning notifications. */
  pushover?: PushoverService
}

interface MpcResult {
  jsonrpc: string
  id: number
  result?: {
    content?: Array<{ type: string; text: string }>
  }
}

export class ComposioClient {
  private url: string
  private apiKey: string
  private sessionId: string | null = null
  private reqId = 0
  private initialized = false
  private redis?: ComposioRedisClient
  private pushover?: PushoverService

  /**
   * Supports two call forms:
   * - `new ComposioClient(apiKey?)` — string or undefined; backward compat, no quota.
   * - `new ComposioClient({ apiKey?, redis?, pushover? })` — options object; enables quota meter.
   */
  constructor(apiKeyOrOptions?: string | ComposioClientOptions) {
    if (typeof apiKeyOrOptions === 'string' || apiKeyOrOptions === undefined) {
      // String/undefined form — backward compat
      this.apiKey = apiKeyOrOptions ?? process.env.COMPOSIO_API_KEY ?? ''
    } else {
      // Options-object form — with optional meter injection
      this.apiKey = apiKeyOrOptions.apiKey ?? process.env.COMPOSIO_API_KEY ?? ''
      this.redis = apiKeyOrOptions.redis
      this.pushover = apiKeyOrOptions.pushover
    }
    this.url = COMPOSIO_URL
  }

  /** Check if the client has an API key configured */
  get isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  /**
   * Returns the Redis key for the current month's Composio usage counter.
   * Format: `composio:monthly_usage:YYYY-MM`
   */
  private getMonthlyKey(): string {
    const now = new Date()
    return `composio:monthly_usage:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  /**
   * Atomically increments the monthly usage counter, sets TTL on first call,
   * fires Pushover warning at 75%, and throws at hard stop (95% of free tier).
   *
   * No-op when redis is not injected (backward compat).
   */
  private async checkAndIncrementQuota(): Promise<void> {
    if (!this.redis) return

    const key = this.getMonthlyKey()
    const count = await this.redis.incr(key)

    // Set TTL on first call (~5 weeks to span month rollover)
    if (count === 1) {
      await this.redis.expire(key, 35 * 24 * 60 * 60).catch(() => {})
    }

    // Hard stop — throw before making the Composio API call
    if (count > COMPOSIO_MONTHLY_HARD_STOP) {
      logger.warn({ count, limit: COMPOSIO_MONTHLY_HARD_STOP }, '[composio] hard stop reached — blocking call')
      await this.pushover
        ?.send({
          title: 'Composio Quota: BLOCKED',
          message: `Hard stop at ${count} calls (limit ${COMPOSIO_MONTHLY_HARD_STOP}).`,
          priority: 1,
        })
        .catch(() => {})
      throw new ComposioQuotaExceededError(count)
    }

    // 75% warning — best-effort (concurrent calls may miss exact threshold)
    if (count === COMPOSIO_WARN_THRESHOLD) {
      logger.warn({ count }, '[composio] 75% monthly quota used')
      await this.pushover
        ?.send({
          title: 'Composio Quota Warning',
          message: `${count} / 20,000 calls used (75%). Hard stop at ${COMPOSIO_MONTHLY_HARD_STOP}.`,
          priority: 1,
        })
        .catch(() => {})
    }
  }

  private async mpcCall(method: string, params: Record<string, unknown> = {}): Promise<MpcResult | null> {
    this.reqId++
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: this.reqId,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'x-consumer-api-key': this.apiKey,
      'User-Agent': 'Mozilla/5.0 (compatible; OpenBrain-Workers/1.0)',
    }
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    })

    if (!response.ok) {
      logger.warn({ status: response.status }, '[composio] MCP call failed')
      return null
    }

    const raw = await response.text()

    // Parse SSE response — look for data: lines
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        const data = JSON.parse(line.slice(5).trim()) as MpcResult
        // Capture session ID from response headers
        const sid = response.headers.get('mcp-session-id')
        if (sid) this.sessionId = sid
        return data
      }
    }

    // Try parsing as direct JSON (non-SSE response)
    try {
      return JSON.parse(raw) as MpcResult
    } catch {
      return null
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await this.mpcCall('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'open-brain-workers', version: '1.0' },
    })
    this.initialized = true
  }

  /**
   * Execute a Composio tool and return the response data.
   *
   * Quota is checked and incremented BEFORE the API call — prevents quota
   * escape under concurrent calls. Throws ComposioQuotaExceededError when the
   * monthly hard stop (19,000 calls) is exceeded.
   *
   * Returns null on failure (non-blocking — callers should handle gracefully).
   */
  async execute(toolSlug: string, args: Record<string, string>): Promise<Record<string, unknown> | null> {
    await this.checkAndIncrementQuota()
    await this.ensureInitialized()

    const result = await this.mpcCall('tools/call', {
      name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      arguments: { tools: [{ tool_slug: toolSlug, arguments: args }] },
    })

    if (!result?.result?.content?.[0]) return null

    const text = result.result.content[0].text ?? '{}'
    try {
      const data = JSON.parse(text) as {
        successful?: boolean
        data?: { results?: Array<{ response?: { data?: Record<string, unknown> } }> }
      }
      if (data.successful && data.data?.results?.[0]) {
        return data.data.results[0].response?.data ?? null
      }
      return null
    } catch {
      logger.warn({ text: text.slice(0, 200) }, '[composio] failed to parse tool response')
      return null
    }
  }
}
