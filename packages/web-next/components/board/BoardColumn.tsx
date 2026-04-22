'use client';

/**
 * BoardColumn — one of the 4 status columns in the Board Kanban.
 *
 * Layout: colored top border (4px) + header (label + count badge) + card list.
 * If empty, renders an empty-state message instead of a blank column.
 *
 * Column top-border colors (Cloudscape screen 09):
 *   pending      → cloud-dark   (neutral, waiting)
 *   owed_by_user → faded-red    (you owe — action required)
 *   waiting_on   → book-cloth   (terracotta — waiting on someone)
 *   resolved     → moss         (green — done)
 *
 * Client component — receives commitments + resolve callback from parent.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BoardCard } from './BoardCard';
import { commitmentsApi } from '@/lib/api-client';
import type { BoardCommitment, CommitmentStatus } from '@/lib/types';

const COLUMN_META: Record<CommitmentStatus, { label: string; topBorder: string; emptyText: string }> = {
  pending:      { label: 'Pending',     topBorder: 'border-t-cloud-dark',   emptyText: 'No pending items' },
  owed_by_user: { label: 'You owe',     topBorder: 'border-t-faded-red',    emptyText: 'Nothing you owe right now' },
  waiting_on:   { label: 'Waiting on',  topBorder: 'border-t-book-cloth',   emptyText: 'Nothing waiting on others' },
  resolved:     { label: 'Resolved',    topBorder: 'border-t-moss',         emptyText: 'No resolved items yet' },
};

interface BoardColumnProps {
  status: CommitmentStatus;
  commitments: BoardCommitment[];
  onNewItem?: () => void;
}

export function BoardColumn({ status, commitments, onNewItem }: BoardColumnProps) {
  const meta = COLUMN_META[status];
  const queryClient = useQueryClient();

  // Track which card is currently being resolved so we can disable its button.
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const resolveMutation = useMutation({
    mutationFn: (id: string) => commitmentsApi.patch(id, { resolved: true }),
    onMutate: (id) => {
      setResolvingId(id);
    },
    onSuccess: () => {
      // Invalidate the board query so the resolved card moves to the Resolved column.
      queryClient.invalidateQueries({ queryKey: ['commitments'] });
    },
    onError: (err) => {
      console.error('[BoardColumn] resolve failed:', err);
      toast.error('Failed to resolve commitment — please try again.');
    },
    onSettled: () => {
      setResolvingId(null);
    },
  });

  return (
    <div className="flex flex-col min-h-0">
      {/* Colored top border + header */}
      <div
        className={[
          'border-t-4 border border-cloud-light bg-bg-container rounded-none',
          meta.topBorder,
          'px-3 py-[10px]',
          'flex items-center justify-between gap-2',
        ].join(' ')}
      >
        <span className="font-mono text-[11px] tracking-[0.06em] uppercase text-text-heading font-medium">
          {meta.label}
        </span>
        <span
          className={[
            'inline-flex items-center justify-center',
            'min-w-[20px] h-[18px] px-[6px]',
            'font-mono text-[10px] tracking-[0.02em]',
            'rounded-badge border border-cloud-light',
            'bg-ivory-dark text-text-body-secondary',
          ].join(' ')}
        >
          {commitments.length}
        </span>
      </div>

      {/* Card list */}
      <div className="flex-1 overflow-y-auto space-y-[8px] py-[10px] px-[2px]">
        {commitments.length === 0 ? (
          <div className="text-center py-8 text-[12px] text-text-body-secondary font-light italic">
            {meta.emptyText}
          </div>
        ) : (
          commitments.map((c) => (
            <BoardCard
              key={c.id}
              commitment={c}
              onResolve={(id) => resolveMutation.mutate(id)}
              resolving={resolvingId === c.id}
            />
          ))
        )}
      </div>

      {/* "New item" button — only on non-resolved columns */}
      {status !== 'resolved' && (
        <div className="pt-[6px] pb-[2px]">
          <button
            type="button"
            onClick={onNewItem}
            className={[
              'w-full flex items-center justify-center',
              'py-[8px] px-3',
              'border border-dashed border-cloud-medium',
              'text-[11.5px] font-mono tracking-[0.04em] uppercase text-text-body-secondary',
              'hover:bg-ivory-dark hover:text-text-heading hover:border-cloud-dark',
              'transition-colors duration-fast cursor-pointer',
            ].join(' ')}
          >
            + New item
          </button>
        </div>
      )}
    </div>
  );
}
