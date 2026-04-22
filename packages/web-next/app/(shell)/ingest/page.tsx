export const dynamic = 'force-dynamic';

/**
 * Ingest page — upload financial/utility data files to the pipeline.
 *
 * Route: /ingest
 *
 * RSC: server-fetches the most recent 20 uploads to seed the RecentUploads
 * table on first render (no loading flash). Client components handle upload
 * interaction and SSE progress tracking.
 *
 * Architecture:
 *   - IngestClient (client) — owns upload state + active upload_id
 *   - FileDropZone (client) — drag-and-drop upload → emits upload_id on success
 *   - IngestProgress (client) — SSE subscription for that upload_id
 *   - RecentUploads (client) — TanStack Query list with 10s polling while in-progress
 *
 * Supported file types (mirrors core-api ingest route heuristics):
 *   CSV: financial statements (AMEX, Chase, Truist, Schwab, HSA, PayPal)
 *   PDF: utility bills (gas, power/electric)
 *   TXT: raw exports
 */

import { Suspense } from 'react';
import { Upload } from 'lucide-react';
import { PageHeader } from '@/components/design-system';
import { IngestClient } from '@/components/ingest/IngestClient';
import { ingestApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Server-side fetch (seeds RecentUploads without a loading flash)
// ---------------------------------------------------------------------------

async function fetchRecentUploads() {
  try {
    return await ingestApi.list({ limit: 20 });
  } catch (err) {
    console.error('[IngestPage] initial fetch failed:', err);
    return { uploads: [], total: 0, limit: 20, offset: 0 };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function IngestPage() {
  const initialData = await fetchRecentUploads();

  const subtitle =
    initialData.total > 0
      ? `${initialData.total} upload${initialData.total !== 1 ? 's' : ''} · drop a CSV or PDF to add more`
      : 'Upload financial statements and utility bills — processed by the pipeline automatically';

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Ingest']}
        title="Ingest"
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
            <Upload size={11} strokeWidth={1.5} />
            <span>Financial &amp; Utility</span>
          </div>
        }
      />

      <Suspense fallback={null}>
        <IngestClient initialData={initialData} />
      </Suspense>
    </>
  );
}
