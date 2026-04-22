'use client';

/**
 * QueuesTab — System page tab 2.
 *
 * Displays BullMQ queue status table (name, waiting, active, completed, failed,
 * delayed counts + health dot). Provides a "Clear failed" action per queue with
 * a confirmation step.
 *
 * Clear action:
 *   1. User clicks "Clear failed" → confirmation row appears inline.
 *   2. User confirms → POST /api/v1/admin/queues/:name/clear { state: 'failed' }
 *   3. Toast on success. Row resets on cancel or completion.
 *
 * Data is refetched after a clear via window.location.reload() (RSC pattern).
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, AlertTriangle } from 'lucide-react';
import { Button, StatusDot } from '@/components/design-system';
import { adminQueuesApi, type QueueStats } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HealthLevel = 'healthy' | 'degraded' | 'unhealthy';

function healthToDotStatus(h: HealthLevel): 'success' | 'warning' | 'error' {
  if (h === 'healthy') return 'success';
  if (h === 'degraded') return 'warning';
  return 'error';
}

// ---------------------------------------------------------------------------
// QueueRow — one row in the table
// ---------------------------------------------------------------------------

interface QueueRowProps {
  queue: QueueStats;
}

function QueueRow({ queue }: QueueRowProps) {
  const [confirming, setConfirming] = useState(false);

  const clearMutation = useMutation({
    mutationFn: () => adminQueuesApi.clear(queue.name, 'failed'),
    onSuccess: (result) => {
      toast.success(`Cleared ${result.cleared_count} failed job${result.cleared_count !== 1 ? 's' : ''} from ${queue.name}`);
      setConfirming(false);
      // Reload to refresh server-side counts
      setTimeout(() => window.location.reload(), 800);
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Clear failed';
      toast.error(`Failed to clear queue: ${message}`);
      setConfirming(false);
    },
  });

  return (
    <>
      <tr className="border-b border-cloud-light last:border-0">
        {/* Status + name */}
        <td className="py-[10px] pr-[16px]">
          <div className="flex items-center gap-[8px]">
            <StatusDot status={healthToDotStatus(queue.status)} />
            <span className="text-[12.5px] font-mono text-text-heading">{queue.name}</span>
          </div>
        </td>

        {/* Waiting */}
        <td className="py-[10px] pr-[16px] text-right">
          <span className="text-[12.5px] font-mono text-text-heading">{queue.waiting}</span>
        </td>

        {/* Active */}
        <td className="py-[10px] pr-[16px] text-right">
          <span className="text-[12.5px] font-mono text-text-heading">{queue.active}</span>
        </td>

        {/* Failed */}
        <td className="py-[10px] pr-[16px] text-right">
          <span
            className={[
              'text-[12.5px] font-mono',
              queue.failed > 0 ? 'text-amber-600' : 'text-text-heading',
            ].join(' ')}
          >
            {queue.failed}
          </span>
        </td>

        {/* Delayed */}
        <td className="py-[10px] pr-[16px] text-right">
          <span className="text-[12.5px] font-mono text-text-heading">{queue.delayed}</span>
        </td>

        {/* Actions */}
        <td className="py-[10px] text-right">
          {queue.failed > 0 && !confirming && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={11} strokeWidth={1.5} />}
              onClick={() => setConfirming(true)}
              className="text-amber-600 hover:text-amber-700"
            >
              Clear failed
            </Button>
          )}
        </td>
      </tr>

      {/* Inline confirmation row */}
      {confirming && (
        <tr className="bg-amber-50 border-b border-amber-200">
          <td colSpan={6} className="py-[10px] px-[0]">
            <div className="flex items-center gap-[10px]">
              <AlertTriangle size={13} strokeWidth={1.5} className="text-amber-600 shrink-0" />
              <span className="text-[12.5px] text-text-heading">
                Clear {queue.failed} failed job{queue.failed !== 1 ? 's' : ''} from{' '}
                <span className="font-mono">{queue.name}</span>? This cannot be undone.
              </span>
              <div className="ml-auto flex items-center gap-[8px]">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={clearMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => clearMutation.mutate()}
                  disabled={clearMutation.isPending}
                  className="bg-amber-600 border-amber-600 hover:bg-amber-700"
                >
                  {clearMutation.isPending ? 'Clearing…' : 'Confirm clear'}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface QueuesTabProps {
  queues: QueueStats[];
}

export function QueuesTab({ queues }: QueuesTabProps) {
  if (queues.length === 0) {
    return (
      <div className="py-[48px] text-center text-[13px] text-text-body-secondary font-light">
        No queue data available — Redis may be unreachable.
      </div>
    );
  }

  const totalFailed = queues.reduce((s, q) => s + q.failed, 0);
  const totalWaiting = queues.reduce((s, q) => s + q.waiting, 0);
  const totalActive = queues.reduce((s, q) => s + q.active, 0);

  return (
    <div>
      {/* Summary bar */}
      <div className="flex flex-wrap gap-[20px] mb-[20px] text-[12.5px] text-text-body-secondary font-light">
        <span>
          <span className="font-mono text-text-heading">{queues.length}</span> queues
        </span>
        <span>
          <span className="font-mono text-text-heading">{totalWaiting}</span> waiting
        </span>
        <span>
          <span className="font-mono text-text-heading">{totalActive}</span> active
        </span>
        <span>
          <span
            className={['font-mono', totalFailed > 0 ? 'text-amber-600' : 'text-text-heading'].join(' ')}
          >
            {totalFailed}
          </span>{' '}
          failed
        </span>
      </div>

      {/* Queue table */}
      <div className="bg-bg-container border border-cloud-light">
        <table className="w-full">
          <thead>
            <tr className="border-b border-cloud-medium">
              <th className="text-left py-[8px] pr-[16px] pl-[14px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
                Queue
              </th>
              <th className="text-right py-[8px] pr-[16px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
                Waiting
              </th>
              <th className="text-right py-[8px] pr-[16px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
                Active
              </th>
              <th className="text-right py-[8px] pr-[16px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
                Failed
              </th>
              <th className="text-right py-[8px] pr-[16px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
                Delayed
              </th>
              <th className="py-[8px] pr-[14px] text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
                {/* Actions column header — empty */}
              </th>
            </tr>
          </thead>
          <tbody className="px-[14px]">
            {queues.map((q) => (
              <QueueRow key={q.name} queue={q} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-[12px] text-[11px] text-text-body-secondary font-light">
        Clear removes failed jobs permanently. Active and waiting jobs are unaffected.
        Queue counts refresh on page reload.
      </div>
    </div>
  );
}
