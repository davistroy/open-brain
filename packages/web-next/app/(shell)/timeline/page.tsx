export const dynamic = 'force-dynamic';

/**
 * Timeline page — Cloudscape screen (M3, item 4.5).
 *
 * RSC: fetches the first page of captures (25 items) server-side with any
 * active brain_view / source filters from searchParams. Passes initial data
 * to TimelineClient so the first render is instant (no loading flash).
 *
 * TimelineFilters handles URL-driven filter state (brain_view tabs + source dropdown).
 * TimelineClient owns infinite-scroll state via useInfiniteQuery + IntersectionObserver.
 *
 * URL params (all optional):
 *   ?view=career        — brain_view filter
 *   ?source=slack       — source filter
 *   (offset managed internally by TimelineClient)
 */

import { Suspense } from 'react';
import { PageHeader } from '@/components/design-system';
import { TimelineFilters } from '@/components/timeline/TimelineFilters';
import { TimelineClient } from '@/components/timeline/TimelineClient';
import { capturesApi } from '@/lib/api-client';
import type { BrainView, CaptureSource } from '@/lib/types';

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Param validation helpers
// ---------------------------------------------------------------------------

const VALID_VIEWS: BrainView[] = ['career', 'personal', 'technical', 'work-internal', 'client'];
const VALID_SOURCES: CaptureSource[] = [
  'slack', 'voice', 'api', 'document', 'mcp', 'email', 'file', 'consolidation', 'system',
];

function resolveView(raw: string | undefined): BrainView | null {
  return VALID_VIEWS.includes(raw as BrainView) ? (raw as BrainView) : null;
}

function resolveSource(raw: string | undefined): CaptureSource | null {
  return VALID_SOURCES.includes(raw as CaptureSource) ? (raw as CaptureSource) : null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface TimelinePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TimelinePage({ searchParams }: TimelinePageProps) {
  const params = await searchParams;

  // Resolve filter params
  const rawView = Array.isArray(params.view) ? params.view[0] : params.view;
  const rawSource = Array.isArray(params.source) ? params.source[0] : params.source;
  const view = resolveView(rawView);
  const source = resolveSource(rawSource);

  // Initial server-side fetch — errors degrade gracefully (empty list; client retries)
  let initialItems: Awaited<ReturnType<typeof capturesApi.list>>['items'] = [];
  let initialTotal = 0;

  try {
    const envelope = await capturesApi.list({
      limit: PAGE_SIZE,
      offset: 0,
      brain_view: view ?? undefined,
      source: source ?? undefined,
    });
    initialItems = envelope.items;
    initialTotal = envelope.total;
  } catch (err) {
    console.error('[TimelinePage] initial fetch failed:', err);
    // Let TimelineClient show empty state; it will attempt re-fetch on scroll.
  }

  // Subtitle
  const filterDesc = [
    view ? `view: ${view}` : null,
    source ? `source: ${source}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const subtitle = filterDesc
    ? `${initialTotal.toLocaleString()} captures · filtered by ${filterDesc}`
    : `${initialTotal.toLocaleString()} captures — reverse chronological`;

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Timeline']}
        title="Timeline"
        subtitle={subtitle}
      />

      {/* Filters bar — client component, reads URL params to mark active state */}
      <Suspense fallback={<div className="h-[33px] border-b border-cloud-light bg-bg-container" />}>
        <TimelineFilters currentView={view} currentSource={source} />
      </Suspense>

      {/* Feed — client component with infinite scroll */}
      <div className="mt-4">
        <TimelineClient
          initialItems={initialItems}
          initialTotal={initialTotal}
          view={view}
          source={source}
        />
      </div>
    </>
  );
}
