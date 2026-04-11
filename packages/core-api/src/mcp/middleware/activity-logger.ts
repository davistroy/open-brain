/**
 * MCP Activity Logger — records every MCP tool invocation.
 *
 * Wraps MCP tool handlers to capture:
 *   - tool_name, parameters (sanitized), result_summary (truncated)
 *   - duration_ms, client_id (from auth header hash)
 *   - optional metadata
 *
 * Inserts into mcp_activity table. Also inserts into activity_feed
 * if an ActivityFeedService is available.
 *
 * Logging is fire-and-forget — failures never block tool execution.
 */

import { mcp_activity } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import type { ActivityFeedService } from '../../services/activity-feed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape returned by MCP tool handlers (content.type uses literal 'text') */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  [key: string]: unknown
}

/** Async MCP tool handler function */
export type McpToolHandler = (input: Record<string, unknown>) => Promise<McpToolResult>

export interface McpActivityLogEntry {
  tool_name: string
  parameters?: Record<string, unknown>
  result_summary?: string
  duration_ms?: number
  client_id?: string
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for result_summary stored in the database */
const RESULT_SUMMARY_MAX_LENGTH = 500

/** Keys that should never be logged in parameters (all lowercase for case-insensitive matching) */
const SENSITIVE_PARAM_KEYS = new Set([
  'password', 'token', 'secret', 'api_key', 'apikey',
  'authorization', 'credential', 'private_key',
])

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class McpActivityLogger {
  constructor(
    private db: Database,
    private activityFeedService?: ActivityFeedService,
  ) {}

  /**
   * Wraps an MCP tool handler to log the invocation, duration, and result.
   * Logging is fire-and-forget — tool execution is never blocked.
   */
  wrapToolHandler(
    toolName: string,
    handler: McpToolHandler,
    clientId?: string,
  ): McpToolHandler {
    return async (input: Record<string, unknown>): Promise<McpToolResult> => {
      const start = Date.now()
      let result: McpToolResult
      let error: Error | undefined

      try {
        result = await handler(input)
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err))
        throw err // re-throw so the MCP server handles the error normally
      } finally {
        const duration_ms = Date.now() - start
        const entry: McpActivityLogEntry = {
          tool_name: toolName,
          parameters: sanitizeParameters(input),
          result_summary: error
            ? `ERROR: ${error.message}`.slice(0, RESULT_SUMMARY_MAX_LENGTH)
            : truncateResult(result!),
          duration_ms,
          client_id: clientId,
          metadata: error ? { error: true, error_message: error.message } : undefined,
        }

        // Fire-and-forget — never block the response
        this.logActivity(entry).catch((logErr) => {
          logger.debug({ logErr, toolName }, 'MCP activity log write failed')
        })
      }

      return result!
    }
  }

  /**
   * Insert an MCP activity log entry into the database.
   * Also inserts into the unified activity feed if available.
   */
  async logActivity(entry: McpActivityLogEntry): Promise<void> {
    // Insert into mcp_activity table
    await this.db.insert(mcp_activity).values({
      tool_name: entry.tool_name,
      client_id: entry.client_id ?? null,
      parameters: entry.parameters ?? null,
      result_summary: entry.result_summary ?? null,
      duration_ms: entry.duration_ms ?? null,
      metadata: entry.metadata ?? null,
    })

    logger.debug(
      {
        tool: entry.tool_name,
        duration_ms: entry.duration_ms,
        client_id: entry.client_id,
      },
      'MCP activity logged',
    )

    // Insert into activity feed (fire-and-forget, graceful if service unavailable)
    if (this.activityFeedService) {
      try {
        await this.activityFeedService.insert({
          type: 'mcp',
          subtype: entry.tool_name,
          summary: `MCP tool "${entry.tool_name}" called (${entry.duration_ms ?? '?'}ms)`,
          detail: {
            tool_name: entry.tool_name,
            duration_ms: entry.duration_ms,
            client_id: entry.client_id,
            has_error: !!entry.metadata?.error,
          },
        })
      } catch (feedErr) {
        logger.debug({ feedErr, tool: entry.tool_name }, 'MCP activity feed insert failed')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize parameters by redacting sensitive keys and truncating large values.
 */
function sanitizeParameters(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_PARAM_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]'
    } else if (typeof value === 'string' && value.length > 200) {
      sanitized[key] = value.slice(0, 200) + '...'
    } else {
      sanitized[key] = value
    }
  }

  return sanitized
}

/**
 * Truncate MCP tool result to a summary string.
 * Extracts text from the content array and truncates to RESULT_SUMMARY_MAX_LENGTH.
 */
function truncateResult(result: McpToolResult): string {
  if (!result?.content?.length) return ''

  // Concatenate all text content blocks
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')

  if (text.length <= RESULT_SUMMARY_MAX_LENGTH) return text
  return text.slice(0, RESULT_SUMMARY_MAX_LENGTH) + '...'
}

// Export helpers for testing
export { sanitizeParameters, truncateResult, RESULT_SUMMARY_MAX_LENGTH, SENSITIVE_PARAM_KEYS }
