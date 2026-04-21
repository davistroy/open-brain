'use client';

import { useState } from 'react';
import { Mic, Mail, FileUp, Calendar, Edit3, Link } from 'lucide-react';
import { Pill, StatusDot } from '@/components/design-system';
import type { Capture, CaptureSource, PipelineStatus } from '@/lib/types';

const SOURCE_ICONS: Record<CaptureSource, React.ReactNode> = {
  voice:       <Mic      size={15} strokeWidth={1.4} />,
  email:       <Mail     size={15} strokeWidth={1.4} />,
  document:    <FileUp   size={15} strokeWidth={1.4} />,
  api:         <Calendar size={15} strokeWidth={1.4} />,
  slack:       <Edit3    size={15} strokeWidth={1.4} />,
  mcp:         <Link     size={15} strokeWidth={1.4} />,
  file:        <FileUp   size={15} strokeWidth={1.4} />,
  consolidation: <Edit3  size={15} strokeWidth={1.4} />,
  system:      <Edit3    size={15} strokeWidth={1.4} />,
};

/** Map pipeline_status to StatusDot variant */
function statusToDot(ps: PipelineStatus): { status: 'success' | 'accent' | 'neutral' | 'processing'; label: string } {
  switch (ps) {
    case 'complete':   return { status: 'success',    label: 'Processed' };
    case 'extracted':  return { status: 'accent',     label: 'Needs review' };
    case 'embedded':   return { status: 'neutral',    label: 'Unlinked' };
    case 'processing': return { status: 'processing', label: 'Processing' };
    default:           return { status: 'success',    label: 'Processed' };
  }
}

/** Format ISO date to display string */
function formatCapturedAt(isoDate: string): string {
  const d = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / (1000 * 60 * 60);
  if (diffH < 24) {
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (diffH < 48) return 'Yesterday';
  if (diffH < 72) return '2d';
  return '3d+';
}

interface RecentCapturesProps {
  captures: Capture[];
}

/**
 * RecentCaptures — dashboard left column captures list.
 * 'use client' — has selected-row expand state.
 * Each row: source icon | title + snippet + entity pills | time + status dot.
 */
export function RecentCaptures({ captures }: RecentCapturesProps) {
  const [selectedId, setSelectedId] = useState<string>(captures[0]?.id ?? '');

  const rows = captures.slice(0, 8);

  return (
    <div>
      {rows.map((capture, i) => {
        const isSelected = capture.id === selectedId;
        const isLast = i === rows.length - 1;
        const dotProps = statusToDot(capture.pipeline_status);
        const icon = SOURCE_ICONS[capture.source] ?? <Edit3 size={15} strokeWidth={1.4} />;

        return (
          <div
            key={capture.id}
            onClick={() => setSelectedId(capture.id)}
            className={[
              'grid gap-[14px] px-[18px] py-[12px] cursor-pointer',
              'transition-[background] duration-[100ms]',
              !isLast ? 'border-b border-cloud-light' : '',
              isSelected
                ? 'bg-book-cloth-50 border-l-[2px] border-l-book-cloth'
                : 'border-l-[2px] border-l-transparent hover:bg-ivory-dark',
            ].filter(Boolean).join(' ')}
            style={{ gridTemplateColumns: '24px 1fr auto' }}
          >
            {/* Source icon */}
            <span className="text-cloud-dark mt-[2px] inline-flex">{icon}</span>

            {/* Content */}
            <div className="min-w-0">
              <div className="text-[13.5px] font-normal text-text-heading tracking-[0.002em] truncate">
                {capture.title ?? capture.content.slice(0, 60)}
              </div>
              <div className="text-[12.5px] text-text-body-secondary font-light mt-[3px] truncate">
                {capture.snippet ?? capture.content.slice(0, 100)}
              </div>
              {capture.entities && capture.entities.length > 0 && (
                <div className="flex gap-[6px] mt-[8px] flex-wrap">
                  {capture.entities.map((entity) => (
                    <Pill key={entity} tone="neutral" size="xs">
                      {entity}
                    </Pill>
                  ))}
                </div>
              )}
            </div>

            {/* Meta: time + status */}
            <div className="flex flex-col items-end gap-[6px] min-w-[110px]">
              <span className="font-mono text-[11px] text-text-body-secondary tracking-[0.02em]">
                {formatCapturedAt(capture.created_at)}
              </span>
              <StatusDot status={dotProps.status} label={dotProps.label} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
