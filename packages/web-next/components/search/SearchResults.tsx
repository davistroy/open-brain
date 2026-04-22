'use client';

/**
 * SearchResults — TanStack Query-powered result cards with flat/grouped toggle.
 *
 * Fetches via searchApi.search({q, hybrid: true, limit: 20}).
 *
 * View modes:
 *   - flat    (List icon)    — ordered results list, one card per result
 *   - grouped (LayoutGrid icon) — results bucketed by source type with section
 *             headers, match counts, and "View all" links. Max 4 per group.
 *
 * Active toggle state: book-cloth underline on the active icon button.
 * View preference persists to localStorage('search-view') and restores on mount.
 *
 * Re-fetches automatically when `query` prop changes (URL-driven).
 * Refetch interval: none — user controls via URL changes.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { List, LayoutGrid } from 'lucide-react';
import { searchApi } from '@/lib/api-client';
import type { SearchResult } from '@/lib/types';
import { ResultCard, GroupedResults } from './GroupedResults';

// ---------------------------------------------------------------------------
// View mode persistence
// ---------------------------------------------------------------------------

type ViewMode = 'flat' | 'grouped';
const LS_KEY = 'search-view';

function readStoredView(): ViewMode {
  if (typeof window === 'undefined') return 'flat';
  const stored = localStorage.getItem(LS_KEY);
  return stored === 'grouped' ? 'grouped' : 'flat';
}

// ---------------------------------------------------------------------------
// Loading skeletons
// ---------------------------------------------------------------------------

function ResultSkeletons() {
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="rounded-container border border-cloud-light bg-bg-container p-4 space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="h-4 w-40 rounded bg-cloud-light" />
            <div className="h-5 w-16 rounded-badge bg-cloud-light" />
          </div>
          <div className="h-3 w-full rounded bg-cloud-light" />
          <div className="h-3 w-[85%] rounded bg-cloud-light" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewToggle button pair
// ---------------------------------------------------------------------------

interface ViewToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Search view">
      {/* Flat / List */}
      <button
        type="button"
        onClick={() => onChange('flat')}
        aria-pressed={mode === 'flat'}
        title="List view"
        className={[
          'flex items-center justify-center w-7 h-7',
          'transition-colors duration-[100ms]',
          'text-text-body-secondary hover:text-text-heading',
          mode === 'flat'
            ? 'text-book-cloth border-b-2 border-book-cloth pb-[1px]'
            : '',
        ].filter(Boolean).join(' ')}
      >
        <List size={15} strokeWidth={1.5} />
      </button>

      {/* Grouped / LayoutGrid */}
      <button
        type="button"
        onClick={() => onChange('grouped')}
        aria-pressed={mode === 'grouped'}
        title="Grouped view"
        className={[
          'flex items-center justify-center w-7 h-7',
          'transition-colors duration-[100ms]',
          'text-text-body-secondary hover:text-text-heading',
          mode === 'grouped'
            ? 'text-book-cloth border-b-2 border-book-cloth pb-[1px]'
            : '',
        ].filter(Boolean).join(' ')}
      >
        <LayoutGrid size={15} strokeWidth={1.5} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SearchResults main component
// ---------------------------------------------------------------------------

interface SearchResultsProps {
  query: string;
}

export function SearchResults({ query }: SearchResultsProps) {
  // Initialise from localStorage on mount; default to 'flat' during SSR
  const [viewMode, setViewMode] = useState<ViewMode>('flat');

  useEffect(() => {
    setViewMode(readStoredView());
  }, []);

  function handleViewChange(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem(LS_KEY, mode);
  }

  const {
    data,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['search', query],
    queryFn: () => searchApi.search({ q: query, hybrid: true, limit: 20 }),
    enabled: Boolean(query.trim()),
    staleTime: 30_000,
  });

  if (isLoading) return <ResultSkeletons />;

  if (isError) {
    return (
      <div className="rounded-container border border-status-error-border bg-status-error-bg px-4 py-3 text-[13px] text-status-error-fg">
        Search failed: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  const results: SearchResult[] = data?.results ?? [];
  const total = data?.total ?? 0;

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-start py-10 px-2 text-left">
        {/* Query display */}
        <p className="font-display text-[24px] font-light italic tracking-[-0.01em] text-text-heading leading-[1.2]">
          &ldquo;{query}&rdquo;
        </p>
        {/* No-match message */}
        <p className="mt-3 text-[13px] font-light text-text-body-secondary">
          Nothing matched — but try broader terms or check for typos.
        </p>
        {/* Soft suggestions prompt */}
        <div className="mt-6 pt-6 border-t border-cloud-light w-full">
          <p className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary mb-3">
            Things that might be related
          </p>
          <div className="flex flex-wrap gap-2">
            {query.trim().split(/\s+/).filter(Boolean).map((term) => (
              <a
                key={term}
                href={`/search?q=${encodeURIComponent(term)}`}
                className={[
                  'inline-flex items-center px-[10px] py-[4px]',
                  'font-mono text-[11px] tracking-[0.02em]',
                  'border border-cloud-medium bg-bg-container',
                  'text-text-body-secondary hover:text-text-heading hover:bg-ivory-dark',
                  'transition-colors duration-[100ms]',
                ].join(' ')}
              >
                {term}
              </a>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Results summary line + view toggle */}
      <div className="flex items-center justify-between text-[11.5px] font-mono tracking-[0.04em] text-text-body-secondary uppercase">
        <span>
          {total} result{total !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
        </span>

        <div className="flex items-center gap-3">
          <span>Hybrid · FTS + vector</span>
          <ViewToggle mode={viewMode} onChange={handleViewChange} />
        </div>
      </div>

      {/* Flat or grouped result display */}
      {viewMode === 'grouped' ? (
        <GroupedResults results={results} query={query} />
      ) : (
        <div className="space-y-2">
          {results.map((result) => (
            <ResultCard key={result.capture.id} result={result} />
          ))}
        </div>
      )}
    </div>
  );
}
