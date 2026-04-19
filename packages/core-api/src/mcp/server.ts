import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Hono } from 'hono'
import type { Queue } from 'bullmq'
import type { CaptureService } from '../services/capture.js'
import type { SearchService } from '../services/search.js'
import type { EntityService } from '../services/entity.js'
import type { WikiService } from '../services/wiki.js'
import type { ActivityFeedService } from '../services/activity-feed.js'
import type { EmailDraftService } from '../services/email-draft.js'
import type { ConfigService, Database } from '@open-brain/shared'
import { validateMcpAuth } from './auth.js'
import { registerMcpTools } from './tools/index.js'
import { generateContextSummary } from './resources/context.js'
import { McpActivityLogger } from './middleware/activity-logger.js'
import { logger } from '@open-brain/shared'
import { createHash } from 'node:crypto'

interface McpServerDeps {
  captureService: CaptureService
  searchService: SearchService
  configService: ConfigService
  db: Database
  entityService?: EntityService
  wikiService?: WikiService
  activityFeedService?: ActivityFeedService
  emailDraftService?: EmailDraftService
  /** Access-stats BullMQ queue — fire-and-forget after search_brain tool completion (P06) */
  accessStatsQueue?: Queue<{ captureIds: string[]; accessedAt: string }>
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
  const { captureService, searchService, configService, db, entityService, wikiService, activityFeedService, emailDraftService, accessStatsQueue } = deps

  // Create the activity logger (shared across requests — it's stateless, just holds db ref)
  const activityLogger = new McpActivityLogger(db, activityFeedService)

  app.all('/mcp', async (c) => {
    // Auth check — fail closed on missing/invalid token
    const authError = validateMcpAuth(c.req.raw)
    if (authError) {
      return authError
    }

    // Derive client_id from the bearer token hash (first 16 hex chars of SHA-256)
    const authHeader = c.req.raw.headers.get('Authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const clientId = token
      ? createHash('sha256').update(token).digest('hex').slice(0, 16)
      : undefined

    const server = new McpServer({
      name: 'open-brain',
      version: '0.1.0',
    })

    registerMcpTools({ server, captureService, searchService, configService, db, entityService, wikiService, emailDraftService, activityLogger, clientId, accessStatsQueue })

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
