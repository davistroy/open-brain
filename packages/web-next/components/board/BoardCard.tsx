'use client';

/**
 * BoardCard — a single commitment item in a Kanban column.
 *
 * Visual anatomy (Cloudscape screen 09):
 *   [4px left stripe — priority color]
 *   [entity tag eyebrow]            [date badge]
 *   [title / commitment text]
 *   [note text / resolve action]
 *
 * Priority stripe rules:
 *   - resolved    → muted (cloud-light bg)
 *   - overdue     → red (faded-red border-l)
 *   - has due_date → terracotta (book-cloth border-l)
 *   - no date     → gray (cloud-dark border-l)
 *
 * Click-to-resolve: "Mark resolved" button calls onResolve(id).
 * Client component — mutations handled via callback prop.
 */

import { Check, Clock } from 'lucide-react';
import type { BoardCommitment } from '@/lib/types';

/** ISO date string "YYYY-MM-DD" → display like "Apr 30" */
function formatDueDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** True if isoDate is strictly before today (date-only comparison). */
function isOverdue(isoDate: string | null): boolean {
  if (!isoDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${isoDate}T00:00:00`);
  return due < today;
}

interface BoardCardProps {
  commitment: BoardCommitment;
  onResolve: (id: string) => void;
  resolving?: boolean;
}

export function BoardCard({ commitment, onResolve, resolving = false }: BoardCardProps) {
  const { id, text, due_date, status, entity_name } = commitment;

  const resolved = status === 'resolved';
  const overdue = !resolved && isOverdue(due_date);

  // Left stripe color
  const stripeClass = resolved
    ? 'border-l-cloud-light'
    : overdue
      ? 'border-l-faded-red'
      : due_date
        ? 'border-l-book-cloth'
        : 'border-l-cloud-dark';

  return (
    <div
      className={[
        'bg-bg-container border border-cloud-light rounded-none',
        'border-l-4',
        stripeClass,
        'p-3 space-y-2',
        'transition-shadow duration-fast hover:shadow-container',
        resolved ? 'opacity-60' : '',
      ].filter(Boolean).join(' ')}
    >
      {/* Top row: entity eyebrow + date badge */}
      <div className="flex items-start justify-between gap-2">
        {/* Entity tag eyebrow */}
        <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-text-body-secondary truncate min-w-0">
          {entity_name ?? 'No entity'}
        </div>

        {/* Due date badge */}
        {due_date && (
          <span
            className={[
              'inline-flex items-center gap-[3px] shrink-0',
              'text-[10.5px] font-mono tracking-[0.03em] px-[6px] py-[2px]',
              'rounded-badge border',
              overdue
                ? 'bg-faded-red-50 border-faded-red text-faded-red'
                : 'bg-ivory-dark border-cloud-light text-text-body-secondary',
            ].join(' ')}
          >
            <Clock size={9} strokeWidth={1.5} />
            {formatDueDate(due_date)}
          </span>
        )}
      </div>

      {/* Commitment text */}
      <p
        className={[
          'text-[13px] leading-[1.45] font-light',
          resolved ? 'line-through text-text-body-secondary' : 'text-text-body',
        ].join(' ')}
      >
        {text}
      </p>

      {/* Resolve action — hidden when already resolved */}
      {!resolved && (
        <div className="pt-1">
          <button
            type="button"
            disabled={resolving}
            onClick={() => onResolve(id)}
            className={[
              'inline-flex items-center gap-[5px]',
              'text-[11px] font-mono tracking-[0.04em] uppercase',
              'text-text-body-secondary hover:text-text-heading',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'cursor-pointer',
            ].join(' ')}
          >
            <Check size={10} strokeWidth={2} />
            {resolving ? 'Resolving…' : 'Mark resolved'}
          </button>
        </div>
      )}
    </div>
  );
}
