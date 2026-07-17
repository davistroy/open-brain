export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/design-system';
import { CaptureHeader } from '@/components/capture/CaptureHeader';
import { AiSummary } from '@/components/capture/AiSummary';
import { TranscriptView } from '@/components/capture/TranscriptView';
import { ExtractionsSidebar } from '@/components/capture/ExtractionsSidebar';
import { RelatedCaptures } from '@/components/capture/RelatedCaptures';
import { capturesApi, entitiesApi, commitmentsApi, HttpError } from '@/lib/api-client';

/**
 * Capture Detail page — Cloudscape screen 10.
 * Async RSC with parallel non-critical fetches.
 * Layout: 2-column grid — content left, 340px extraction sidebar right.
 * Calls notFound() for any 404 response from the API.
 */
export default async function CaptureDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Critical-path fetch — 404 → notFound()
  let capture;
  try {
    capture = await capturesApi.get(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  // Non-critical: entities linked to this capture + open commitments for capture
  const [entitiesResult, commitmentsResult, relatedResult] = await Promise.allSettled([
    entitiesApi.list({ limit: 50 }),
    commitmentsApi.list({ limit: 20 }),
    capturesApi.related(id, { limit: 8 }),
  ]);

  // Filter entities to those mentioned in this capture (by name match in content)
  const allEntities =
    entitiesResult.status === 'fulfilled' ? entitiesResult.value.items : [];
  const captureEntities = allEntities.filter((e) =>
    capture.content?.toLowerCase().includes(e.name.toLowerCase()),
  );

  // Filter commitments linked to this capture
  const allCommitments =
    commitmentsResult.status === 'fulfilled' ? commitmentsResult.value.items : [];
  const captureCommitments = allCommitments.filter((c) => c.capture_id === id);

  const relatedCaptures =
    relatedResult.status === 'fulfilled' ? relatedResult.value : [];

  // Breadcrumb date: format created_at as "APR 21, 2026"
  const captureDate = capture.created_at
    ? new Date(capture.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).toUpperCase()
    : 'CAPTURE';

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Captures', captureDate]}
      />

      {/* 2-col layout: main content | extraction sidebar */}
      <div
        className="grid gap-6 items-start"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}
      >
        {/* Left column — header, AI summary, transcript */}
        <div className="flex flex-col gap-5">
          <CaptureHeader capture={capture} entityCount={captureEntities.length} />
          <AiSummary capture={capture} />
          <TranscriptView capture={capture} entities={captureEntities} />
        </div>

        {/* Right sidebar — entities, decisions, commitments */}
        <aside className="flex flex-col gap-5">
          <ExtractionsSidebar
            entities={captureEntities}
            commitments={captureCommitments}
            captureContent={capture.content ?? ''}
          />
          <RelatedCaptures related={relatedCaptures} />
        </aside>
      </div>
    </>
  );
}
