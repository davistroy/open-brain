'use client';

/**
 * FlowsTab — System page tab 4.
 *
 * Shows recent pipeline execution flows: capture_id, overall status, and a
 * stage-by-stage progression bar. Useful for debugging stuck captures.
 *
 * Data is passed as props from the RSC page (server-prefetched flows list).
 * No mutations — read-only view.
 */

import { CheckCircle, XCircle, Clock, AlertCircle } from 'lucide-react';
import type { PipelineFlowEntry } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'Just now';
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type PipelineStatus = string;

const STATUS_COLORS: Record<string, string> = {
  complete: 'bg-emerald-500',
  embedded: 'bg-emerald-400',
  extracted: 'bg-sky-500',
  chunked: 'bg-sky-400',
  processing: 'bg-amber-400',
  pending: 'bg-cloud-dark',
  failed: 'bg-red-500',
  deleted: 'bg-cloud-medium',
};

function statusColor(status: PipelineStatus): string {
  return STATUS_COLORS[status] ?? 'bg-cloud-medium';
}

const STAGE_STATUS_ICON: Record<string, React.ReactNode> = {
  success: <CheckCircle size={11} strokeWidth={1.5} className="text-emerald-500" />,
  failed: <XCircle size={11} strokeWidth={1.5} className="text-red-500" />,
  started: <Clock size={11} strokeWidth={1.5} className="text-amber-500" />,
};

// ---------------------------------------------------------------------------
// FlowRow — one collapsed capture flow
// ---------------------------------------------------------------------------

interface FlowRowProps {
  flow: PipelineFlowEntry;
}

function FlowRow({ flow }: FlowRowProps) {
  return (
    <div className="py-[12px] border-b border-cloud-light last:border-0">
      {/* Header row */}
      <div className="flex items-center gap-[12px] mb-[8px]">
        {/* Status dot */}
        <span
          className={['w-[8px] h-[8px] shrink-0 inline-block', statusColor(flow.pipeline_status)].join(' ')}
        />

        {/* Capture ID */}
        <span className="text-[11.5px] font-mono text-text-body-secondary truncate flex-1 max-w-[280px]">
          {flow.capture_id}
        </span>

        {/* Pipeline status */}
        <span className="text-[12px] font-light text-text-heading capitalize">
          {flow.pipeline_status}
        </span>

        {/* Relative time */}
        <span className="text-[11px] text-text-body-secondary font-light shrink-0">
          {fmtRelative(flow.created_at)}
        </span>
      </div>

      {/* Stage progression */}
      {flow.stages.length > 0 && (
        <div className="flex flex-wrap gap-[6px] ml-[20px]">
          {flow.stages.map((stage, i) => (
            <div
              key={`${stage.stage}-${i}`}
              className="flex items-center gap-[4px] bg-cloud-light px-[6px] py-[2px]"
              title={stage.error ?? stage.status}
            >
              {STAGE_STATUS_ICON[stage.status] ?? (
                <AlertCircle size={11} strokeWidth={1.5} className="text-text-body-secondary" />
              )}
              <span className="text-[10.5px] font-mono text-text-body-secondary">
                {stage.stage}
              </span>
              {stage.duration_ms !== null && (
                <span className="text-[9.5px] text-text-body-secondary font-light">
                  {fmtDuration(stage.duration_ms)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* No stages yet */}
      {flow.stages.length === 0 && (
        <div className="ml-[20px] text-[11px] text-text-body-secondary font-light">
          No stage events recorded yet.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface FlowsTabProps {
  flows: PipelineFlowEntry[];
}

export function FlowsTab({ flows }: FlowsTabProps) {
  if (flows.length === 0) {
    return (
      <div className="py-[48px] text-center text-[13px] text-text-body-secondary font-light">
        No recent pipeline flows. Captures appear here once the pipeline processes them.
      </div>
    );
  }

  return (
    <div>
      <div className="text-[12.5px] text-text-body-secondary font-light mb-[16px]">
        Showing {flows.length} most recent pipeline flows. Stages are shown in execution order.
      </div>

      <div className="bg-bg-container border border-cloud-light px-[14px]">
        {flows.map((flow) => (
          <FlowRow key={flow.capture_id} flow={flow} />
        ))}
      </div>
    </div>
  );
}
