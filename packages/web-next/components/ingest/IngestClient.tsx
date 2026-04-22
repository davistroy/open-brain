'use client';

/**
 * IngestClient — client orchestrator for the Ingest page.
 *
 * Owns the active upload state (upload_id + filename) and wires:
 *   1. FileDropZone — drag-and-drop upload → fires onUploaded(id, filename)
 *   2. IngestProgress — SSE subscription on that upload_id
 *   3. RecentUploads — TanStack Query list; highlights the active upload
 *
 * Source type selector (financial / utility) is passed as an option to
 * FileDropZone. The selector defaults to 'financial' (most common).
 * The user can leave it unset — the core-api route auto-detects from filename.
 */

import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileDropZone } from './FileDropZone';
import { IngestProgress } from './IngestProgress';
import { RecentUploads, INGEST_UPLOADS_QUERY_KEY } from './RecentUploads';
import type { IngestSourceType, ListUploadsResponse } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Source type selector options
// ---------------------------------------------------------------------------

const SOURCE_TYPES: { value: IngestSourceType | ''; label: string; hint: string }[] = [
  { value: '',           label: 'Auto-detect',  hint: 'Filename determines source' },
  { value: 'financial',  label: 'Financial',    hint: 'CSV/PDF statements' },
  { value: 'utility',    label: 'Utility',      hint: 'Bills, power, gas' },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface IngestClientProps {
  /** Server-fetched initial upload list — seeds TanStack Query cache. */
  initialData: ListUploadsResponse;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IngestClient({ initialData }: IngestClientProps) {
  const queryClient = useQueryClient();
  const [sourceType, setSourceType] = useState<IngestSourceType | ''>('');
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);
  const [activeFilename, setActiveFilename] = useState<string | null>(null);

  const handleUploaded = useCallback((uploadId: string, filename: string) => {
    setActiveUploadId(uploadId);
    setActiveFilename(filename);
    toast.success('File uploaded', {
      description: `${filename} — processing started`,
      duration: 4000,
    });
    // Invalidate the list so the new row appears immediately
    void queryClient.invalidateQueries({ queryKey: INGEST_UPLOADS_QUERY_KEY });
  }, [queryClient]);

  const handleError = useCallback((message: string) => {
    toast.error('Upload failed', { description: message, duration: 6000 });
  }, []);

  const handleComplete = useCallback((captureIds: string[]) => {
    if (captureIds.length > 0) {
      toast.success('Pipeline complete', {
        description: `${captureIds.length} capture${captureIds.length !== 1 ? 's' : ''} created`,
        duration: 5000,
      });
    }
    // Refresh the list to show updated status
    void queryClient.invalidateQueries({ queryKey: INGEST_UPLOADS_QUERY_KEY });
  }, [queryClient]);

  return (
    <div className="space-y-8">
      {/* Upload section */}
      <div>
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="font-display text-[16px] text-[var(--color-text-heading)] font-normal">
            Upload file
          </h2>

          {/* Source type selector */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
              Source
            </span>
            <div className="flex gap-1.5">
              {SOURCE_TYPES.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setSourceType(value)}
                  title={SOURCE_TYPES.find(s => s.value === value)?.hint}
                  className={[
                    'px-2.5 py-1 rounded-[2px] font-mono text-[10.5px] uppercase tracking-[0.04em] border transition-colors duration-100',
                    sourceType === value
                      ? 'border-[var(--color-book-cloth)] bg-[var(--color-book-cloth)] text-white'
                      : 'border-[var(--color-rule)] bg-transparent text-[var(--color-text-body-secondary)] hover:text-[var(--color-text-body)] hover:border-[var(--color-text-body-secondary)]',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <FileDropZone
          options={sourceType ? { source_type: sourceType } : {}}
          onUploaded={handleUploaded}
          onError={handleError}
        />

        {/* Usage notes */}
        <div className="mt-4 space-y-1">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
            Recognised filename patterns
          </p>
          <ul className="space-y-1 text-[12.5px] text-[var(--color-text-body-secondary)]">
            <li className="flex gap-2">
              <span className="text-[var(--color-book-cloth)] shrink-0">·</span>
              Financial: activity.csv (AMEX), chase*activity*.csv, acct_*.csv (Truist), *_transactions_*.csv, *_balances_*.csv, *-positions-*.csv (Schwab), hsa*.csv, download*.csv (PayPal)
            </li>
            <li className="flex gap-2">
              <span className="text-[var(--color-book-cloth)] shrink-0">·</span>
              Utility: gas*.pdf (gas bill), power*.csv / electric*.csv
            </li>
            <li className="flex gap-2">
              <span className="text-[var(--color-book-cloth)] shrink-0">·</span>
              Unknown filenames require manual source type selection above.
            </li>
          </ul>
        </div>
      </div>

      {/* Progress tracking — only shown while an upload is active */}
      {activeUploadId && (
        <div>
          <h2 className="font-display text-[16px] text-[var(--color-text-heading)] font-normal mb-3">
            Processing
          </h2>
          <IngestProgress
            uploadId={activeUploadId}
            filename={activeFilename}
            onComplete={handleComplete}
          />
        </div>
      )}

      {/* Recent uploads table */}
      <div>
        <h2 className="font-display text-[16px] text-[var(--color-text-heading)] font-normal mb-3">
          Recent uploads
        </h2>
        <div className="border border-[var(--color-rule)] rounded-[4px] overflow-hidden">
          <RecentUploads activeUploadId={activeUploadId} limit={20} initialData={initialData} />
        </div>
      </div>
    </div>
  );
}
