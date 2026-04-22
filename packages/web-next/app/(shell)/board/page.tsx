export const dynamic = 'force-dynamic';

/**
 * Board page — Cloudscape screen 09.
 *
 * RSC: fetches all commitments from core-api server-side; groups into 4 columns
 * by status. Passes grouped data to BoardClient which owns mutation state,
 * resolve actions, and the "New item" creation modal.
 *
 * The 4 columns map directly to CommitmentStatus values:
 *   Pending      → status = 'pending'
 *   You owe      → status = 'owed_by_user'
 *   Waiting on   → status = 'waiting_on'
 *   Resolved     → status = 'resolved'
 */

import { PageHeader } from '@/components/design-system';
import { BoardClient } from '@/components/board/BoardClient';
import { commitmentsApi } from '@/lib/api-client';
import type { BoardCommitment, CommitmentStatus } from '@/lib/types';

/** Group a flat list of commitments by their status. */
function groupByStatus(items: BoardCommitment[]): Record<CommitmentStatus, BoardCommitment[]> {
  return {
    pending:      items.filter((c) => c.status === 'pending'),
    owed_by_user: items.filter((c) => c.status === 'owed_by_user'),
    waiting_on:   items.filter((c) => c.status === 'waiting_on'),
    resolved:     items.filter((c) => c.status === 'resolved'),
  };
}

export default async function BoardPage() {
  let commitments: BoardCommitment[] = [];

  try {
    // Fetch up to 200 commitments — board is bounded by practical obligation counts.
    const envelope = await commitmentsApi.list({ limit: 200 });
    commitments = envelope.items;
  } catch {
    // On fetch failure, render the board with empty columns (BoardClient shows empty states).
    // The error boundary at board/error.tsx catches thrown errors — here we prefer
    // degraded rendering over a full error page so the "New item" button is still usable.
  }

  const grouped = groupByStatus(commitments);

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Board']}
        title="Board"
        subtitle="Commitments and decisions — extracted from your captures"
      />

      <BoardClient initialGrouped={grouped} />
    </>
  );
}
