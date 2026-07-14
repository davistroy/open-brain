'use client';

/**
 * RecentUploads — paginated table of recent file_uploads rows.
 *
 * Uses TanStack Query to fetch GET /api/v1/ingest/uploads.
 * Shows status badge (pending/processing/parsed/failed) and a re-process button
 * for failed rows.
 *
 * Pipeline status lifecycle: pending → processing → parsed (terminal success)
 *                            pending → processing → failed  (terminal failure)
 */

import { RefreshCw, FileText, Loader2, AlertCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Pill, EmptyState } from '@/components/design-system';
import { useClientNow } from '@/hooks/useClientNow';
import { useIngestUploads, useReprocessUpload, INGEST_UPLOADS_QUERY_KEY } from '@/lib/api/ingest.hooks';
import type { FileUploadStatus, ListUploadsResponse } from '@/lib/api-client';
import { toast } from 'sonner';

/** Re-export so IngestClient can invalidate after upload without importing hooks. */
export { INGEST_UPLOADS_QUERY_KEY };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string, now: number | null): string {
  const d = new Date(iso);
  // Pre-mount (SSR + first client render): stable absolute date, no `now` dependency.
  if (now === null) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const diffMs = now - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusTone(status: FileUploadStatus): 'neutral' | 'warning' | 'success' | 'error' | 'accent' {
  switch (status) {
    case 'pending':    return 'warning';
    case 'processing': return 'accent';
    case 'parsed':     return 'success';
    case 'failed':     return 'error';
    default:           return 'neutral';
  }
}

function statusLabel(status: FileUploadStatus): string {
  switch (status) {
    case 'pending':    return 'Pending';
    case 'processing': return 'Processing';
    case 'parsed':     return 'Complete';
    case 'failed':     return 'Failed';
    default:           return status;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RecentUploadsProps {
  /** Highlighted upload_id from a just-completed upload — gets a subtle highlight. */
  activeUploadId?: string | null;
  limit?: number;
  /** Server-fetched initial data to seed TanStack Query cache (RSC → client handoff). */
  initialData?: ListUploadsResponse;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 10_000; // 10s polling while any row is non-terminal

export function RecentUploads({ activeUploadId, limit = 20, initialData }: RecentUploadsProps) {
  const queryClient = useQueryClient();
  const now = useClientNow();
  const { data, isLoading, isError, error } = useIngestUploads(
    { limit },
    {
      initialData,
      // Poll while there are in-progress rows (pending/processing)
      refetchInterval: (query) => {
        const uploads = query.state.data?.uploads ?? [];
        const hasInProgress = uploads.some(
          (u) => u.status === 'pending' || u.status === 'processing',
        );
        return hasInProgress ? REFRESH_INTERVAL_MS : false;
      },
    },
  );

  const reprocessMutation = useReprocessUpload();

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[var(--color-text-body-secondary)]">
        <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />
        <span className="font-mono text-[11px] uppercase tracking-wider">Loading uploads…</span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------

  if (isError) {
    return (
      <div className="flex items-center gap-2 py-6 text-[#b05040]">
        <AlertCircle size={16} strokeWidth={1.4} />
        <span className="text-[13px]">
          {error instanceof Error ? error.message : 'Failed to load uploads'}
        </span>
      </div>
    );
  }

  const uploads = data?.uploads ?? [];

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------

  if (uploads.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No uploads yet"
        description="Files you upload will appear here with their pipeline status."
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Header row */}
      <div className="grid grid-cols-[1fr_100px_80px_80px_100px] gap-3 px-3 py-2 border-b border-[var(--color-rule)]">
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-body-secondary)]">
          Filename
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-body-secondary)]">
          Source
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-body-secondary)]">
          Size
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-body-secondary)]">
          Status
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-body-secondary)]">
          Uploaded
        </span>
      </div>

      {/* Rows */}
      <div className="divide-y divide-[var(--color-rule)]">
        {uploads.map((upload) => {
          const isActive = upload.id === activeUploadId;
          const isFailed = upload.status === 'failed';
          const isReprocessing = reprocessMutation.isPending && reprocessMutation.variables === upload.id;

          return (
            <div
              key={upload.id}
              className={[
                'grid grid-cols-[1fr_100px_80px_80px_100px] gap-3 px-3 py-2.5 items-center transition-colors duration-200',
                isActive ? 'bg-[#f5f1ec]' : 'hover:bg-[#faf8f5]',
              ].join(' ')}
            >
              {/* Filename + captures count */}
              <div className="min-w-0">
                <span
                  className="block font-body text-[13px] text-[var(--color-text-body)] truncate"
                  title={upload.filename}
                >
                  {upload.filename}
                </span>
                {upload.captures.length > 0 && (
                  <span className="font-mono text-[10px] text-[var(--color-text-body-secondary)] uppercase tracking-wider">
                    {upload.captures.length} capture{upload.captures.length !== 1 ? 's' : ''}
                  </span>
                )}
                {upload.parser_hint && (
                  <span className="font-mono text-[10px] text-[var(--color-text-body-secondary)] uppercase tracking-wider ml-2">
                    · {upload.parser_hint}
                  </span>
                )}
              </div>

              {/* Source type */}
              <span className="font-mono text-[11px] text-[var(--color-text-body-secondary)] uppercase tracking-wider">
                {upload.source_type}
              </span>

              {/* Size */}
              <span className="font-mono text-[11px] text-[var(--color-text-body-secondary)]">
                {formatSize(upload.size_bytes)}
              </span>

              {/* Status badge + re-process for failed */}
              <div className="flex items-center gap-1.5">
                <Pill tone={statusTone(upload.status)} size="xs">
                  {statusLabel(upload.status)}
                </Pill>
                {isFailed && (
                  <button
                    onClick={() =>
                      reprocessMutation.mutate(upload.id, {
                        onSuccess: (_result, id) => {
                          toast.success('Reprocess queued', {
                            description: `Upload ${id.slice(0, 8)}… has been re-enqueued.`,
                            duration: 4000,
                          });
                        },
                        onError: (err, id) => {
                          const message = err instanceof Error ? err.message : 'Failed to reprocess';
                          toast.error('Reprocess failed', {
                            description: `${id.slice(0, 8)}… — ${message}`,
                            duration: 5000,
                          });
                        },
                      })
                    }
                    disabled={isReprocessing}
                    title="Retry processing"
                    className="text-[var(--color-text-body-secondary)] hover:text-[var(--color-book-cloth)] transition-colors disabled:opacity-50"
                    aria-label="Retry processing"
                  >
                    <RefreshCw
                      size={12}
                      strokeWidth={1.6}
                      className={isReprocessing ? 'animate-spin' : ''}
                    />
                  </button>
                )}
              </div>

              {/* Uploaded time */}
              <span className="font-mono text-[10.5px] text-[var(--color-text-body-secondary)]">
                {formatDate(upload.uploaded_at, now)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer: total count */}
      {(data?.total ?? 0) > uploads.length && (
        <div className="px-3 pt-2.5 pb-1">
          <p className="font-mono text-[10.5px] text-[var(--color-text-body-secondary)] uppercase tracking-wider">
            Showing {uploads.length} of {data?.total} uploads
          </p>
        </div>
      )}

      {/* Manual refresh button */}
      <div className="px-3 pt-3 pb-1 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={11} strokeWidth={1.6} />}
          onClick={() => void queryClient.invalidateQueries({ queryKey: INGEST_UPLOADS_QUERY_KEY })}
        >
          Refresh
        </Button>
      </div>
    </div>
  );
}
