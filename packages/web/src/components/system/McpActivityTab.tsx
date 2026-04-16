import { useState } from 'react';
import {
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { McpActivityEntry } from '@/lib/types';
import { relativeTime, formatDuration } from './helpers';

export interface McpActivityTabProps {
  entries: McpActivityEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
  hasMore: boolean;
}

export function McpActivityTab({
  entries,
  total,
  loading,
  error,
  onLoadMore,
  hasMore,
}: McpActivityTabProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (loading && entries.length === 0) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded bg-secondary" />)}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        <Wrench className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No MCP activity recorded yet.</p>
        <p className="text-xs mt-1">MCP tool calls will appear here as they happen.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{total} total entries</p>
      <div className="rounded-lg border bg-card divide-y">
        {entries.map((entry) => {
          const isExpanded = expanded.has(entry.id);
          return (
            <div key={entry.id} className="px-4 py-3">
              <button
                className="w-full flex items-center justify-between gap-3 text-left"
                onClick={() => toggleExpand(entry.id)}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <Badge variant="outline" className="text-xs font-mono shrink-0">
                    {entry.tool_name}
                  </Badge>
                  {entry.client_id && (
                    <span className="text-xs text-muted-foreground truncate">
                      {entry.client_id.length > 12 ? entry.client_id.slice(0, 12) + '...' : entry.client_id}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                  {entry.duration_ms != null && (
                    <span>{formatDuration(entry.duration_ms)}</span>
                  )}
                  <span>{relativeTime(entry.timestamp)}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="mt-2 ml-6 space-y-2">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Timestamp:</span>{' '}
                    {new Date(entry.timestamp).toLocaleString()}
                  </div>
                  {entry.client_id && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Client:</span> {entry.client_id}
                    </div>
                  )}
                  {entry.parameters && Object.keys(entry.parameters).length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-1">Parameters:</p>
                      <pre className="text-xs bg-secondary/50 rounded p-2 overflow-x-auto max-h-40">
                        {JSON.stringify(entry.parameters, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.result_summary && (
                    <div>
                      <p className="text-xs font-medium mb-1">Result:</p>
                      <pre className="text-xs bg-secondary/50 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
                        {entry.result_summary}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button size="sm" variant="outline" onClick={onLoadMore} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Loading...
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
