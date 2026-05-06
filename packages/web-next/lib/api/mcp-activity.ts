/**
 * MCP activity API — paginated MCP tool invocation log.
 * Extracted from lib/api-client.ts (domain split, Phase 8a).
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request, buildQueryString } from './core'
import type { ListEnvelope } from './core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One MCP activity record */
export interface McpActivityEntry {
  id: string
  timestamp: string
  tool_name: string
  client_id: string | null
  duration_ms: number | null
  success: boolean
  input_summary: string | null
  output_summary: string | null
}

export interface McpActivityListParams {
  limit?: number
  offset?: number
  tool_name?: string
  client_id?: string
  since?: string
}

// ---------------------------------------------------------------------------
// mcpActivityApi
// ---------------------------------------------------------------------------

export const mcpActivityApi = {
  /**
   * GET /api/v1/mcp/activity — paginated MCP activity log.
   * Supports filtering by tool_name, client_id, since (ISO 8601).
   */
  list: (params: McpActivityListParams = {}): Promise<ListEnvelope<McpActivityEntry>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<McpActivityEntry>>(`/mcp/activity${qs}`)
  },
}
