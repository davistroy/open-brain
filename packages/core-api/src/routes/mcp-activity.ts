/**
 * MCP Activity routes — paginated log of MCP tool invocations.
 *
 * GET /api/v1/mcp/activity — list MCP activity entries (paginated, filterable)
 *   Query params:
 *     - limit (number, default 50, max 200)
 *     - offset (number, default 0)
 *     - tool_name (string, filter by tool name)
 *     - client_id (string, filter by client ID hash)
 *     - since (ISO 8601 date string, filter entries after this timestamp)
 */

import type { Hono } from 'hono'
import { desc, and, eq, gte, sql } from 'drizzle-orm'
import { mcp_activity } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'

export function registerMcpActivityRoutes(app: Hono, db: Database): void {
  app.get('/api/v1/mcp/activity', async (c) => {
    const limitParam = Number(c.req.query('limit') ?? 50)
    const limit = Math.min(Math.max(1, limitParam), 200)
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
    const toolName = c.req.query('tool_name')
    const clientId = c.req.query('client_id')
    const sinceParam = c.req.query('since')

    const conditions: ReturnType<typeof eq>[] = []

    if (toolName) {
      conditions.push(eq(mcp_activity.tool_name, toolName))
    }
    if (clientId) {
      conditions.push(eq(mcp_activity.client_id, clientId))
    }
    if (sinceParam) {
      const sinceDate = new Date(sinceParam)
      if (!isNaN(sinceDate.getTime())) {
        conditions.push(gte(mcp_activity.timestamp, sinceDate))
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    try {
      const [items, countResult] = await Promise.all([
        db
          .select()
          .from(mcp_activity)
          .where(where)
          .orderBy(desc(mcp_activity.timestamp))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<string>`count(*)` })
          .from(mcp_activity)
          .where(where),
      ])

      const total = Number(countResult[0]?.count ?? 0)

      return c.json({
        items,
        total,
        limit,
        offset,
      })
    } catch (err) {
      logger.error({ err }, 'Failed to query MCP activity')
      return c.json({ error: 'Failed to query MCP activity' }, 500)
    }
  })
}
