'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckSquare, Square, ClipboardList } from 'lucide-react';
import { Card, EmptyState } from '@/components/design-system';
import { commitmentsApi } from '@/lib/api-client';
import type { BoardCommitment } from '@/lib/types';

interface CommitmentsCardProps {
  entityId: string;
}

/** Format an ISO date string (YYYY-MM-DD) for display. */
function formatDueDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Returns true if due_date is in the past (overdue). Compares date-only, not time. */
function isOverdue(isoDate: string): boolean {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return isoDate < todayStr;
}

interface CommitmentRowProps {
  commitment: BoardCommitment;
  /** Optimistic resolved ids from mutation in-flight */
  resolvingId: string | null;
  onResolve: (id: string) => void;
}

function CommitmentRow({ commitment, resolvingId, onResolve }: CommitmentRowProps) {
  const overdue = commitment.due_date ? isOverdue(commitment.due_date) : false;
  const isResolving = resolvingId === commitment.id;

  return (
    <div className="flex items-start gap-3 px-[18px] py-[11px] border-b border-cloud-light last:border-0 hover:bg-ivory-dark transition-colors duration-[120ms]">
      {/* Resolve checkbox */}
      <button
        onClick={() => onResolve(commitment.id)}
        disabled={isResolving}
        aria-label="Mark resolved"
        className="flex-shrink-0 mt-[1px] bg-transparent border-none cursor-pointer p-0 disabled:cursor-wait"
        style={{ color: isResolving ? 'var(--color-cloud-dark)' : 'var(--color-book-cloth)' }}
      >
        {isResolving ? (
          <CheckSquare size={15} strokeWidth={1.4} />
        ) : (
          <Square size={15} strokeWidth={1.4} />
        )}
      </button>

      {/* Commitment text */}
      <div className="flex-1 min-w-0">
        <div
          className="text-text-heading"
          style={{ fontSize: 13.5, lineHeight: 1.5, fontWeight: 400 }}
        >
          {commitment.text}
        </div>

        {/* Status + due date row */}
        <div className="flex items-center gap-2 mt-[4px]">
          {/* Status pill */}
          <span
            style={{
              fontFamily: 'var(--font-family-monospace)',
              fontSize: 9.5,
              letterSpacing: '0.07em',
              color: 'var(--color-book-cloth-dark)',
            }}
          >
            {commitment.status === 'owed_by_user' ? 'YOU OWE' :
             commitment.status === 'waiting_on' ? 'WAITING ON' : 'PENDING'}
          </span>

          {/* Due date badge */}
          {commitment.due_date && (
            <span
              style={{
                fontFamily: 'var(--font-family-monospace)',
                fontSize: 9.5,
                letterSpacing: '0.06em',
                padding: '1px 5px',
                background: overdue ? 'var(--color-error-soft, #FEE2E2)' : 'var(--color-cloud-light)',
                color: overdue ? 'var(--color-error, #DC2626)' : 'var(--color-text-body-secondary)',
                border: overdue ? '1px solid var(--color-error-border, #FECACA)' : 'none',
              }}
            >
              DUE {formatDueDate(commitment.due_date)}
              {overdue ? ' · OVERDUE' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Active commitments card for entity detail page.
 * Fetches open commitments from GET /api/v1/entities/:id/commitments.
 * Displays sorted by due_date ASC (API sorts; nulls last client-side).
 * Resolve checkbox: optimistic update + query invalidation.
 * Client component.
 */
export function CommitmentsCard({ entityId }: CommitmentsCardProps) {
  const queryClient = useQueryClient();

  const queryKey = ['commitments', 'entity', entityId];

  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => commitmentsApi.forEntity(entityId),
    staleTime: 30_000,
  });

  // Track in-flight resolve id for per-row pending state
  const resolveMutation = useMutation({
    mutationFn: (id: string) => commitmentsApi.patch(id, { resolved: true }),

    // Optimistic update: remove the resolved commitment from the list immediately
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: typeof data) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.filter((c) => c.id !== id),
          total: Math.max(0, old.total - 1),
        };
      });
      return { previous };
    },

    onError: (_err, _id, context) => {
      // Roll back on error
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      toast.error('Failed to resolve commitment — please try again.');
    },

    onSettled: () => {
      // Always refetch after mutation to sync with server
      queryClient.invalidateQueries({ queryKey });
    },
  });

  // Sort items: due_date ASC, nulls last
  const sorted = data?.items.slice().sort((a, b) => {
    if (!a.due_date && !b.due_date) return 0;
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date);
  }) ?? [];

  return (
    <Card
      header="Active commitments"
      description="Extracted from captures — waiting, owing, or asked"
      padded={false}
    >
      {isLoading && (
        <div
          className="px-[18px] py-[14px] text-text-body-secondary"
          style={{ fontSize: 13 }}
        >
          Loading…
        </div>
      )}

      {isError && (
        <div
          className="px-[18px] py-[14px] text-text-body-secondary"
          style={{ fontSize: 13 }}
        >
          Could not load commitments.
        </div>
      )}

      {!isLoading && !isError && sorted.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title="No open commitments"
          description="Commitments are extracted automatically from your captures."
        />
      )}

      {!isLoading && !isError && sorted.length > 0 && (
        <div>
          {sorted.map((commitment) => (
            <CommitmentRow
              key={commitment.id}
              commitment={commitment}
              resolvingId={resolveMutation.isPending ? (resolveMutation.variables ?? null) : null}
              onResolve={(id) => resolveMutation.mutate(id)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
