'use client';

/**
 * McpActivityTab — System page tab 5.
 *
 * Paginated log of MCP tool invocations from GET /api/v1/mcp/activity.
 * Columns: timestamp, tool_name, success (dot), duration, client_id.
 *
 * Pagination: offset-based, LIMIT 25 per page. Prev/Next buttons.
 * Filter: tool_name dropdown (derived from visible rows).
 *
 * Data is fetched client-side with TanStack Query (useQuery) to support
 * pagination without a full page reload. Initial data is passed from RSC.
 */

import { useState } from 'react';
import { CheckCircle, XCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/design-system';
import { useMcpActivity } from '@/lib/api/mcp-activity.hooks';
import type { McpActivityEntry, ListEnvelope } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// ActivityTable
// ---------------------------------------------------------------------------

function ActivityTable({ items }: { items: McpActivityEntry[] }) {
  if (items.length === 0) {
    return (
      <div className="py-[32px] text-center text-[13px] text-text-body-secondary font-light">
        No MCP activity recorded.
      </div>
    );
  }

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-cloud-medium">
          <th className="text-left py-[8px] pr-[12px] pl-[14px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
            Time
          </th>
          <th className="text-left py-[8px] pr-[12px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
            Tool
          </th>
          <th className="text-center py-[8px] pr-[12px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
            Status
          </th>
          <th className="text-right py-[8px] pr-[12px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
            Duration
          </th>
          <th className="text-left py-[8px] pr-[14px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
            Client
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((entry) => (
          <tr key={entry.id} className="border-b border-cloud-light last:border-0">
            <td className="py-[8px] pr-[12px] pl-[14px]">
              <span className="text-[11px] font-mono text-text-body-secondary">
                {fmtTimestamp(entry.timestamp)}
              </span>
            </td>
            <td className="py-[8px] pr-[12px]">
              <span className="text-[12.5px] font-mono text-text-heading">
                {entry.tool_name}
              </span>
              {entry.input_summary && (
                <div className="text-[10.5px] text-text-body-secondary font-light truncate max-w-[200px]">
                  {entry.input_summary}
                </div>
              )}
            </td>
            <td className="py-[8px] pr-[12px] text-center">
              {entry.success ? (
                <CheckCircle size={13} strokeWidth={1.5} className="text-emerald-500 inline" />
              ) : (
                <XCircle size={13} strokeWidth={1.5} className="text-red-500 inline" />
              )}
            </td>
            <td className="py-[8px] pr-[12px] text-right">
              <span className="text-[11.5px] font-mono text-text-body-secondary">
                {fmtDuration(entry.duration_ms)}
              </span>
            </td>
            <td className="py-[8px] pr-[14px]">
              <span className="text-[11px] font-mono text-text-body-secondary truncate max-w-[120px] block">
                {entry.client_id ?? '—'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface McpActivityTabProps {
  /** Server-prefetched first page */
  initialData: ListEnvelope<McpActivityEntry>;
}

export function McpActivityTab({ initialData }: McpActivityTabProps) {
  const [offset, setOffset] = useState(0);
  const [toolFilter, setToolFilter] = useState('');

  const { data, isLoading, isError } = useMcpActivity(
    { limit: PAGE_SIZE, offset, tool_name: toolFilter || undefined },
    { initialData: offset === 0 && !toolFilter ? initialData : undefined },
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // Derive unique tool names from initial data for filter dropdown
  const toolNames = Array.from(
    new Set(initialData.items.map((e) => e.tool_name)),
  ).sort();

  function handlePrev() {
    setOffset(Math.max(0, offset - PAGE_SIZE));
  }

  function handleNext() {
    if (offset + PAGE_SIZE < total) {
      setOffset(offset + PAGE_SIZE);
    }
  }

  function handleToolFilter(value: string) {
    setToolFilter(value);
    setOffset(0);
  }

  return (
    <div>
      {/* Filter + summary bar */}
      <div className="flex items-center justify-between mb-[16px]">
        <div className="text-[12.5px] text-text-body-secondary font-light">
          {total} total invocations
        </div>
        <div className="flex items-center gap-[10px]">
          <select
            value={toolFilter}
            onChange={(e) => handleToolFilter(e.target.value)}
            className={[
              'text-[12px] border border-cloud-medium bg-bg-container',
              'px-[8px] py-[5px] text-text-heading outline-none',
              'focus:border-book-cloth',
            ].join(' ')}
          >
            <option value="">All tools</option>
            {toolNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-bg-container border border-cloud-light mb-[12px]">
        {isLoading ? (
          <div className="py-[32px] text-center text-[13px] text-text-body-secondary font-light">
            Loading…
          </div>
        ) : isError ? (
          <div className="py-[32px] text-center text-[13px] text-red-600 font-light">
            Failed to load MCP activity. Check that the API is reachable.
          </div>
        ) : (
          <ActivityTable items={items} />
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-text-body-secondary font-light">
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex items-center gap-[6px]">
            <Button
              variant="secondary"
              size="sm"
              icon={<ChevronLeft size={12} strokeWidth={1.5} />}
              onClick={handlePrev}
              disabled={offset === 0 || isLoading}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconRight={<ChevronRight size={12} strokeWidth={1.5} />}
              onClick={handleNext}
              disabled={offset + PAGE_SIZE >= total || isLoading}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
