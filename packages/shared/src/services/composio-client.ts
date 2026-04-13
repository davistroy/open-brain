/**
 * Lightweight Composio MCP client for batch scripts and workers.
 *
 * Calls the Composio Streamable HTTP MCP endpoint to execute pre-built
 * integrations (Gmail, Outlook Calendar, Drive, Sheets, Notion, Slack).
 *
 * Usage:
 *   const client = new ComposioClient(apiKey)
 *   const events = await client.execute('OUTLOOK_GET_CALENDAR_VIEW', { ... })
 *
 * Requires: COMPOSIO_API_KEY env var or constructor param.
 * API key stored in Bitwarden as OPENCLAW_COMPOSIO_API_KEY.
 */

import { createLogger } from '../lib/logger.js'

const logger = createLogger('composio')

const COMPOSIO_URL = 'https://connect.composio.dev/mcp'

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

  constructor(apiKey?: string) {
    this.url = COMPOSIO_URL
    this.apiKey = apiKey || process.env.COMPOSIO_API_KEY || ''
  }

  /** Check if the client has an API key configured */
  get isConfigured(): boolean {
    return this.apiKey.length > 0
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
   * Returns null on failure (non-blocking — callers should handle gracefully).
   */
  async execute(toolSlug: string, args: Record<string, string>): Promise<Record<string, unknown> | null> {
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
