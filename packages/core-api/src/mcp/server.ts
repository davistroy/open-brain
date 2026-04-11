import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Hono } from 'hono'
import type { CaptureService } from '../services/capture.js'
import type { SearchService } from '../services/search.js'
import type { EntityService } from '../services/entity.js'
import type { WikiService } from '../services/wiki.js'
import type { ConfigService, Database } from '@open-brain/shared'
import { validateMcpAuth } from './auth.js'
import { registerMcpTools } from './tools/index.js'
import { generateContextSummary } from './resources/context.js'
import { logger } from '@open-brain/shared'

interface McpServerDeps {
  captureService: CaptureService
  searchService: SearchService
  configService: ConfigService
  db: Database
  entityService?: EntityService
  wikiService?: WikiService
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
  const { captureService, searchService, configService, db, entityService, wikiService } = deps

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

    registerMcpTools({ server, captureService, searchService, configService, db, entityService, wikiService })

    // Register MCP resources
    server.registerResource(
      'brain-context',
      'open_brain://context',
      { description: 'Current brain context summary — active projects, recent entities, open questions, focus areas' },
      async () => ({
        contents: [{
          uri: 'open_brain://context',
          text: await generateContextSummary(db),
          mimeType: 'text/markdown',
        }],
      }),
    )

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
