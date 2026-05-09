/**
 * TanStack Query hooks — mcp-activity domain (Phase G.1).
 *
 * Query key hierarchy:
 *   ['mcp-activity', offset, toolFilter]  — paginated activity log
 *
 * The McpActivityTab component paginates with offset + toolFilter state, so
 * both are encoded in the query key so each page/filter combo is cached
 * independently.
 */

import { useQuery } from '@tanstack/react-query'
import { mcpActivityApi } from './mcp-activity'
import type { McpActivityListParams } from './mcp-activity'
import type { ListEnvelope } from './core'
import type { McpActivityEntry } from './mcp-activity'

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Paginated MCP activity log.
 *
 * `staleTime: 30_000` matches the existing inline usage in McpActivityTab.
 * `initialData` is forwarded for offset=0 / no-filter case (RSC pre-fetch).
 */
export function useMcpActivity(
  params: McpActivityListParams = {},
  options?: { initialData?: ListEnvelope<McpActivityEntry> },
) {
  const { limit, offset = 0, tool_name, client_id, since } = params
  return useQuery({
    queryKey: ['mcp-activity', offset, tool_name ?? ''],
    queryFn: () => mcpActivityApi.list({ limit, offset, tool_name, client_id, since }),
    initialData: options?.initialData,
    staleTime: 30_000,
  })
}
