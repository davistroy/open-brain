import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Hono } from 'hono'
import type { CaptureService } from '../services/capture.js'
import type { SearchService } from '../services/search.js'
import type { ConfigService, Database } from '@open-brain/shared'
import { validateMcpAuth } from './auth.js'
import { registerMcpTools } from './tools/index.js'
import { logger } from '../lib/logger.js'

interface McpServerDeps {
  captureService: CaptureService
  searchService: SearchService
  configService: ConfigService
  db: Database
}

/**
 * Creates an MCP server and mounts it at the /mcp route on the Hono app.
 *
 * Transport: Streamable HTTP (stateless per-request sessions, web-standard).
 * Auth: Authorization: Bearer header validated against MCP_BEARER_TOKEN env var.
 *
 * Each request gets its own McpServer + transport instance (stateless mode).
 * This is the correct approach for Hono/edge environments and avoids shared state.
 */
export function mountMcpServer(app: Hono, deps: McpServerDeps): void {
  const { captureService, searchService, configService, db } = deps

  app.all('/mcp', async (c) => {
    // Auth check — fail closed on missing/invalid token
    const authError = validateMcpAuth(c.req.raw)
    if (authError) {
      return authError
    }

    const server = new McpServer({
      name: 'open-brain',
      version: '0.1.0',
    })

    registerMcpTools({ server, captureService, searchService, configService, db })

    // WebStandardStreamableHTTPServerTransport works natively with Hono (web-standard Request/Response)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode — no session tracking
    })

    try {
      await server.connect(transport)
      const response = await transport.handleRequest(c.req.raw)
      return response
    } catch (err) {
      logger.error({ err }, 'MCP server error handling request')
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  })

  logger.info('MCP server mounted at /mcp (Streamable HTTP, stateless, web-standard)')
}
