import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Play, History, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { IntelligenceEntry } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillHistoryCardProps {
  /** Display title, e.g. "Connections" or "Drift Monitor" */
  title: string;
  /** Short description shown below the title */
  description: string;
  /** Icon rendered next to the title */
  icon: React.ReactNode;
  /** Skill identifier used for the trigger call */
  skillName: 'daily-connections' | 'drift-monitor';
  /** Most recent entry (from summary or latest endpoint). May be null before first run. */
  latestEntry: IntelligenceEntry | null;
  /** Function that fetches history entries on demand */
  fetchHistory: (limit?: number) => Promise<{ data: IntelligenceEntry[] }>;
  /** Function that triggers a new skill run */
  onTrigger: (skill: 'daily-connections' | 'drift-monitor') => Promise<void>;
  /** Whether a trigger is currently in-flight (managed by parent) */
  triggering?: boolean;
  /** Optional className on the root Card */
  className?: string;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { badge: string; icon: React.ReactNode }> = {
  completed: {
    badge: 'bg-green-100 text-green-700 border-green-200',
    icon: <CheckCircle2 className="h-3 w-3 text-green-600" />,
  },
  failed: {
    badge: 'bg-red-100 text-red-700 border-red-200',
    icon: <XCircle className="h-3 w-3 text-red-600" />,
  },
  running: {
    badge: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    icon: <Loader2 className="h-3 w-3 text-yellow-600 animate-spin" />,
  },
};

function statusStyle(entry: IntelligenceEntry) {
  // Infer status: if duration_ms exists the run completed; if output_summary is null it may have failed
  if (entry.duration_ms != null && entry.output_summary) return STATUS_STYLES.completed;
  if (entry.duration_ms != null && !entry.output_summary) return STATUS_STYLES.failed;
  return STATUS_STYLES.running;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Expandable history row
// ---------------------------------------------------------------------------

function HistoryRow({ entry }: { entry: IntelligenceEntry }) {
  const [expanded, setExpanded] = useState(false);
  const style = statusStyle(entry);

  // Build a human-readable result preview from the JSONB result
  const resultPreview = entry.result ? buildResultPreview(entry.result) : null;

  return (
    <div className="border-b last:border-b-0">
      <button
        className="flex w-full items-center gap-2 px-1 py-2 text-left hover:bg-accent/50 transition-colors rounded-sm"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="shrink-0">{style.icon}</span>
        <span className="flex-1 min-w-0 text-xs truncate text-muted-foreground">
          {formatRelativeTime(entry.created_at)}
        </span>
        <Badge variant="outline" className={cn('text-[10px] border', style.badge)}>
          {formatDuration(entry.duration_ms)}
        </Badge>
      </button>

      {expanded && (
        <div className="pl-8 pr-2 pb-3 space-y-2">
          {/* Output summary */}
          {entry.output_summary && (
            <p className="text-sm leading-relaxed">{entry.output_summary}</p>
          )}

          {/* Structured result details */}
          {resultPreview && resultPreview.length > 0 && (
            <div className="space-y-1.5">
              {resultPreview.map((item, i) => (
                <div key={i} className="rounded-md bg-accent/40 px-2.5 py-1.5">
                  {item.label && (
                    <p className="text-xs font-medium mb-0.5">{item.label}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{item.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* Fallback: raw JSON for anything not covered by preview */}
          {!entry.output_summary && !resultPreview && entry.result && (
            <pre className="rounded-md bg-accent/40 p-2 text-[11px] overflow-x-auto max-h-48 text-muted-foreground">
              {JSON.stringify(entry.result, null, 2)}
            </pre>
          )}

          {/* Meta line */}
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
            <span>{new Date(entry.created_at).toLocaleString()}</span>
            {entry.capture_id && <span>capture: {entry.capture_id.slice(0, 8)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result preview builder — extracts structured items from JSONB result
// ---------------------------------------------------------------------------

interface PreviewItem {
  label?: string;
  text: string;
}

function buildResultPreview(result: Record<string, unknown>): PreviewItem[] | null {
  const items: PreviewItem[] = [];

  // daily-connections: result.connections is an array of { theme, insight, confidence }
  if (Array.isArray(result.connections)) {
    for (const conn of result.connections as Array<{ theme?: string; insight?: string; confidence?: number }>) {
      const label = conn.theme
        ? `${conn.theme}${conn.confidence != null ? ` (${Math.round(conn.confidence * 100)}%)` : ''}`
        : undefined;
      if (conn.insight) {
        items.push({ label, text: conn.insight });
      }
    }
  }

  // drift-monitor: result.drift_items is an array of { item, severity, suggested_action }
  if (Array.isArray(result.drift_items)) {
    for (const d of result.drift_items as Array<{ item?: string; severity?: string; suggested_action?: string }>) {
      const severityTag = d.severity ? `[${d.severity}]` : '';
      const label = d.item ? `${severityTag} ${d.item}`.trim() : severityTag || undefined;
      if (d.suggested_action) {
        items.push({ label, text: d.suggested_action });
      }
    }
  }

  // Generic: if result has a "summary" string
  if (typeof result.summary === 'string' && items.length === 0) {
    items.push({ text: result.summary });
  }

  return items.length > 0 ? items : null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SkillHistoryCard({
  title,
  description,
  icon,
  skillName,
  latestEntry,
  fetchHistory,
  onTrigger,
  triggering = false,
  className,
}: SkillHistoryCardProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<IntelligenceEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetchHistory(20);
      setHistory(res.data);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  }, [fetchHistory]);

  // Fetch history when the panel is opened
  useEffect(() => {
    if (showHistory && history.length === 0 && !historyLoading) {
      loadHistory();
    }
  }, [showHistory, history.length, historyLoading, loadHistory]);

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-lg">{title}</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onTrigger(skillName)}
            disabled={triggering}
            className="gap-1.5 text-xs"
          >
            {triggering ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {triggering ? 'Queuing...' : 'Run'}
          </Button>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent>
        {/* Latest entry */}
        {latestEntry ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="default" className="text-xs">
                {latestEntry.duration_ms
                  ? `${(latestEntry.duration_ms / 1000).toFixed(1)}s`
                  : 'completed'}
              </Badge>
              <span>{formatRelativeTime(latestEntry.created_at)}</span>
            </div>
            {latestEntry.output_summary && (
              <p className="text-sm line-clamp-4">{latestEntry.output_summary}</p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
            <p className="text-sm">No analysis yet.</p>
            <p className="text-xs mt-1">Click "Run" to generate your first analysis.</p>
          </div>
        )}

        {/* History toggle */}
        <div className="mt-3 pt-2 border-t">
          <button
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="h-3.5 w-3.5" />
            <span>{showHistory ? 'Hide history' : 'Show run history'}</span>
            <span className="ml-auto">
              {showHistory ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          </button>

          {showHistory && (
            <div className="mt-2">
              {historyLoading && (
                <div className="flex items-center gap-2 justify-center py-4 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading history...
                </div>
              )}

              {historyError && (
                <div className="text-xs text-destructive py-2">{historyError}</div>
              )}

              {!historyLoading && !historyError && history.length === 0 && (
                <p className="text-xs text-muted-foreground py-2 text-center">No runs recorded yet.</p>
              )}

              {!historyLoading && history.length > 0 && (
                <div className="max-h-80 overflow-y-auto">
                  {history.map((entry) => (
                    <HistoryRow key={entry.id} entry={entry} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
