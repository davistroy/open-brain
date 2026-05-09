'use client';

/**
 * BoardClient — client shell for the Board Kanban page.
 *
 * Receives server-fetched, grouped commitments as initial data and renders
 * 4 BoardColumn instances. Owns:
 *   - GroupByBar state (grouping toggle)
 *   - "New item" modal state + POST /commitments mutation
 *   - TanStack Query cache for post-resolve invalidation
 *
 * Architecture: RSC page (page.tsx) fetches + groups data server-side;
 * BoardClient owns all mutation state so the RSC stays a pure async function.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { GroupByBar, type GroupBy } from './GroupByBar';
import { BoardColumn } from './BoardColumn';
import { Button } from '@/components/design-system/Button';
import { Input } from '@/components/design-system/Input';
import { useCreateCommitment } from '@/lib/api/commitments.hooks';
import type { BoardCommitment, CommitmentStatus } from '@/lib/types';

const COLUMN_ORDER: CommitmentStatus[] = ['pending', 'owed_by_user', 'waiting_on', 'resolved'];

interface BoardClientProps {
  initialGrouped: Record<CommitmentStatus, BoardCommitment[]>;
}

export function BoardClient({ initialGrouped }: BoardClientProps) {
  // GroupByBar state — Status is default per Cloudscape screen 09.
  // Other groupings are accepted by UI but fall back to status grouping (M3).
  const [groupBy, setGroupBy] = useState<GroupBy>('status');

  // "New item" modal state
  const [modalOpen, setModalOpen] = useState(false);
  // Which column triggered "New item" (pre-fills status in modal)
  const [modalStatus, setModalStatus] = useState<CommitmentStatus>('pending');

  // New item form state
  const [newText, setNewText] = useState('');
  const [newDueDate, setNewDueDate] = useState('');

  // Use server data directly — invalidation from resolve mutations re-fetches via
  // queryClient.invalidateQueries which triggers RSC revalidation in Next.js 16.
  // For M3, we use initialGrouped + track optimistic updates via query cache.
  const grouped = initialGrouped;

  const createMutation = useCreateCommitment();

  function openModal(status: CommitmentStatus) {
    setModalStatus(status);
    setNewText('');
    setNewDueDate('');
    setModalOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newText.trim()) return;
    createMutation.mutate(
      { text: newText.trim(), status: modalStatus, due_date: newDueDate || undefined },
      {
        onSuccess: () => {
          toast.success('Commitment added');
          setModalOpen(false);
          setNewText('');
          setNewDueDate('');
        },
        onError: (err) => {
          console.error('[BoardClient] create failed:', err);
          toast.error('Failed to add commitment — please try again.');
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: GroupByBar + New item button */}
      <div className="flex items-center justify-between gap-4">
        <GroupByBar value={groupBy} onChange={setGroupBy} />
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={12} strokeWidth={2} />}
          onClick={() => openModal('pending')}
        >
          New item
        </Button>
      </div>

      {/* 4-column Kanban grid */}
      <div className="grid grid-cols-4 gap-4 items-start min-h-[400px]">
        {COLUMN_ORDER.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            commitments={grouped[status]}
            onNewItem={() => openModal(status)}
          />
        ))}
      </div>

      {/* New item modal — Radix-free inline dialog (M3 keeps dependencies minimal) */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-dark/30"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div
            className="bg-bg-container border border-cloud-light shadow-dropdown w-full max-w-[420px] mx-4 rounded-none"
            role="dialog"
            aria-modal="true"
            aria-label="Add commitment"
          >
            {/* Modal header */}
            <div className="px-5 py-4 border-b border-cloud-light flex items-center justify-between">
              <span className="font-display text-[16px] font-normal text-text-heading tracking-[-0.01em]">
                New commitment
              </span>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-text-body-secondary hover:text-text-heading transition-colors duration-fast cursor-pointer text-[18px] leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Modal body */}
            <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
              {/* Commitment text */}
              <div className="space-y-1.5">
                <label
                  htmlFor="board-new-text"
                  className="block font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary"
                >
                  Commitment
                </label>
                <textarea
                  id="board-new-text"
                  value={newText}
                  onChange={(e) => setNewText(e.target.value)}
                  placeholder="Describe the commitment…"
                  rows={3}
                  required
                  className={[
                    'w-full resize-none rounded-none border border-border-input bg-bg-input',
                    'px-3 py-2 text-[13px] text-text-body leading-[1.5] font-light',
                    'focus:outline-none focus:border-border-input-focused',
                    'placeholder:text-text-disabled',
                    'transition-colors duration-fast',
                  ].join(' ')}
                />
              </div>

              {/* Status selector */}
              <div className="space-y-1.5">
                <label
                  htmlFor="board-new-status"
                  className="block font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary"
                >
                  Status
                </label>
                <select
                  id="board-new-status"
                  value={modalStatus}
                  onChange={(e) => setModalStatus(e.target.value as CommitmentStatus)}
                  className={[
                    'w-full rounded-none border border-border-input bg-bg-input',
                    'px-3 py-[7px] text-[13px] text-text-body font-light',
                    'focus:outline-none focus:border-border-input-focused',
                    'transition-colors duration-fast cursor-pointer',
                  ].join(' ')}
                >
                  <option value="pending">Pending</option>
                  <option value="owed_by_user">You owe</option>
                  <option value="waiting_on">Waiting on</option>
                </select>
              </div>

              {/* Due date */}
              <div className="space-y-1.5">
                <label
                  htmlFor="board-new-due"
                  className="block font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary"
                >
                  Due date <span className="normal-case tracking-normal opacity-60">(optional)</span>
                </label>
                <Input
                  id="board-new-due"
                  type="date"
                  value={newDueDate}
                  onChange={(e) => setNewDueDate(e.target.value)}
                />
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={createMutation.isPending || !newText.trim()}
                >
                  {createMutation.isPending ? 'Adding…' : 'Add commitment'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
