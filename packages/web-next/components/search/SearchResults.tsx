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
      <div className="flex flex-col items-center py-12 text-center text-text-body-secondary border border-dashed border-cloud-light rounded-container">
        <p className="text-[14px] font-light">No results for &ldquo;{query}&rdquo;</p>
        <p className="text-[12.5px] mt-1 font-light">Try different terms or a broader search.</p>
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
