'use client';

/**
 * TimelineClient — client component owning infinite-scroll state for the timeline.
 *
 * Architecture:
 *   - RSC page.tsx fetches the first page (25 items) server-side and passes as
 *     `initialItems`. This avoids a loading flash on first render.
 *   - TimelineClient uses TanStack `useInfiniteQuery` with the same initialData
 *     so the query cache is pre-seeded without a second network round-trip.
 *   - IntersectionObserver on a sentinel div at the bottom of the list triggers
 *     `fetchNextPage()` when the user scrolls near the end.
 *   - Date grouping is done client-side by extracting YYYY-MM-DD from `created_at`.
 *
 * Pagination: offset-based, PAGE_SIZE=25.
 * Group headers: "Today", "Yesterday", "Mon Apr 14" (see TimelineGroup.formatGroupHeader).
 */

import { useEffect, useRef, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { TimelineGroup } from './TimelineGroup';
import { capturesApi } from '@/lib/api-client';
import type { Capture, BrainView, CaptureSource } from '@/lib/types';
import type { ListEnvelope } from '@/lib/api-client';

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Date grouping
// ---------------------------------------------------------------------------

/** Extract a YYYY-MM-DD local date key from an ISO 8601 timestamp. */
function toDateKey(isoString: string): string {
  const d = new Date(isoString);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Group an ordered capture list by YYYY-MM-DD. Preserves order within each group. */
function groupCaptures(captures: Capture[]): Array<{ dateKey: string; captures: Capture[] }> {
  const map = new Map<string, Capture[]>();

  for (const capture of captures) {
    const key = toDateKey(capture.created_at);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(capture);
  }

  // Map preserves insertion order; captures are already reverse-chronological
  // so earlier keys represent more recent dates.
  return Array.from(map.entries()).map(([dateKey, items]) => ({ dateKey, captures: items }));
}

// ---------------------------------------------------------------------------
// TimelineClient
// ---------------------------------------------------------------------------

interface TimelineClientProps {
  initialItems: Capture[];
  initialTotal: number;
  view: BrainView | null;
  source: CaptureSource | null;
}

export function TimelineClient({ initialItems, initialTotal, view, source }: TimelineClientProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Build the initial TanStack page so we don't re-fetch what the RSC already loaded.
  const initialData: { pages: ListEnvelope<Capture>[]; pageParams: number[] } = {
    pages: [{ items: initialItems, total: initialTotal, limit: PAGE_SIZE, offset: 0 }],
    pageParams: [0],
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isError,
    error,
  } = useInfiniteQuery({
    queryKey: ['timeline', { view, source }],
    queryFn: ({ pageParam = 0 }) =>
      capturesApi.list({
        limit: PAGE_SIZE,
        offset: pageParam as number,
        brain_view: view ?? undefined,
        source: source ?? undefined,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((acc, p) => acc + p.items.length, 0);
      return fetched < lastPage.total ? fetched : undefined;
    },
    initialData,
    // Don't refetch on window focus — timeline is append-only
    refetchOnWindowFocus: false,
  });

  // Flatten all pages into a single ordered list (already reverse-chronological)
  const allCaptures: Capture[] = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[0]?.total ?? initialTotal;

  // Group by date
  const groups = groupCaptures(allCaptures);

  // IntersectionObserver — fires fetchNextPage when sentinel enters viewport
  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [entry] = entries;
      if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage],
  );

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(handleIntersect, {
      root: null,
      rootMargin: '200px',  // trigger 200px before reaching bottom
      threshold: 0,
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [handleIntersect]);

  // Error state (only shown if all pages fail — initial data came from RSC)
  if (isError) {
    console.error('[TimelineClient] infinite query error:', error);
  }

  return (
    <div>
      {/* Count header */}
      <div className="px-4 py-[8px] border-b border-cloud-light flex items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary">
          {total.toLocaleString()} captures
        </span>
        {isError && (
          <span className="text-[11px] text-faded-red font-mono">
            Failed to load more — scroll up to retry
          </span>
        )}
      </div>

      {/* Date-grouped capture list */}
      <div className="border border-cloud-light border-t-0 bg-bg-container">
        {groups.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-text-body-secondary font-light">
            No captures match the current filters.
          </div>
        ) : (
          groups.map(({ dateKey, captures: groupCaptures }) => (
            <TimelineGroup key={dateKey} dateKey={dateKey} captures={groupCaptures} />
          ))
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} aria-hidden="true" />

        {/* Loading indicator */}
        {isFetchingNextPage && (
          <div className="flex items-center justify-center gap-2 py-4 text-text-body-secondary">
            <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
            <span className="font-mono text-[11px] tracking-[0.04em] uppercase">
              Loading more…
            </span>
          </div>
        )}

        {/* End of list */}
        {!hasNextPage && allCaptures.length > 0 && (
          <div className="px-4 py-4 text-center font-mono text-[11px] tracking-[0.04em] uppercase text-text-body-secondary border-t border-cloud-light">
            End of timeline
          </div>
        )}
      </div>
    </div>
  );
}
