import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Clock,
  GitBranch,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { PipelineFlowEntry } from '@/lib/types';
import { relativeTime, formatDuration } from './helpers';

export interface FlowsTabProps {
  flows: PipelineFlowEntry[];
  loading: boolean;
  error: string | null;
}

function stageStatusIcon(status: string) {
  if (status === 'complete' || status === 'completed' || status === 'success') {
    return <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />;
  }
  if (status === 'failed' || status === 'error') {
    return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  }
  if (status === 'processing' || status === 'active') {
    return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />;
  }
  return <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
}

function pipelineStatusBadge(status: string) {
  const variant = status === 'complete' ? 'default'
    : status === 'failed' ? 'destructive'
    : status === 'processing' ? 'secondary'
    : 'outline';
  return <Badge variant={variant} className="text-[10px] px-1.5 py-0">{status}</Badge>;
}

function FlowList({
  flows,
  expanded,
  onToggle,
}: {
  flows: PipelineFlowEntry[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-card divide-y">
      {flows.map((flow) => {
        const isExpanded = expanded.has(flow.capture_id);
        const totalDuration = flow.stages.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
        const failedStages = flow.stages.filter(s => s.status === 'failed' || s.status === 'error');

        return (
          <div key={flow.capture_id} className="px-4 py-3">
            <button
              className="w-full flex items-center justify-between gap-3 text-left"
              onClick={() => onToggle(flow.capture_id)}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-xs font-mono text-muted-foreground truncate">
                  {flow.capture_id.slice(0, 8)}
                </span>
                {pipelineStatusBadge(flow.pipeline_status)}
                {failedStages.length > 0 && (
                  <span className="text-xs text-destructive">{failedStages.length} failed</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                <span>{flow.stages.length} stages</span>
                {totalDuration > 0 && <span>{formatDuration(totalDuration)}</span>}
                <span>{relativeTime(flow.created_at)}</span>
              </div>
            </button>

            {isExpanded && (
              <div className="mt-3 ml-6">
                {flow.trace_id && (
                  <div className="text-xs text-muted-foreground mb-2">
                    <span className="font-medium text-foreground">Trace:</span>{' '}
                    <span className="font-mono">{flow.trace_id.slice(0, 12)}...</span>
                  </div>
                )}

                {/* Tree view of stages */}
                <div className="space-y-1">
                  {flow.stages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No stage events recorded.</p>
                  ) : (
                    flow.stages.map((stage, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-xs">
                        <div className="w-4 flex justify-center text-muted-foreground/40">
                          {idx < flow.stages.length - 1 ? '|' : 'L'}
                        </div>
                        {stageStatusIcon(stage.status)}
                        <span className="font-mono font-medium">{stage.stage}</span>
                        <Badge
                          variant={stage.status === 'complete' || stage.status === 'completed' || stage.status === 'success' ? 'default' :
                            stage.status === 'failed' || stage.status === 'error' ? 'destructive' : 'outline'}
                          className="text-[9px] px-1 py-0"
                        >
                          {stage.status}
                        </Badge>
                        {stage.duration_ms != null && (
                          <span className="text-muted-foreground">{formatDuration(stage.duration_ms)}</span>
                        )}
                        {stage.started_at && (
                          <span className="text-muted-foreground/60">{relativeTime(stage.started_at)}</span>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {/* Show errors */}
                {failedStages.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {failedStages.map((s, i) => (
                      <div key={i} className="text-xs bg-destructive/5 border border-destructive/20 rounded px-2 py-1">
                        <span className="font-mono font-medium text-destructive">{s.stage}:</span>{' '}
                        <span className="text-destructive/80">{s.error ?? 'Unknown error'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FlowsTab({
  flows,
  loading,
  error,
}: FlowsTabProps) {
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

  if (loading && flows.length === 0) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <div key={i} className="h-16 animate-pulse rounded bg-secondary" />)}
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No pipeline flows found.</p>
        <p className="text-xs mt-1">Captures processed through the pipeline will appear here.</p>
      </div>
    );
  }

  // Split into active (processing/pending) and recent completed
  const active = flows.filter(f => f.pipeline_status === 'processing' || f.pipeline_status === 'pending');
  const completed = flows.filter(f => f.pipeline_status !== 'processing' && f.pipeline_status !== 'pending');

  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Active Flows ({active.length})</h3>
          <FlowList flows={active} expanded={expanded} onToggle={toggleExpand} />
        </div>
      )}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-2">
          Recent Flows ({completed.length})
        </h3>
        <FlowList flows={completed} expanded={expanded} onToggle={toggleExpand} />
      </div>
    </div>
  );
}
