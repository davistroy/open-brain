'use client';

/**
 * SearchResults — TanStack Query-powered result cards.
 *
 * Fetches via searchApi.search({q, hybrid: true, limit: 20}).
 * Each result renders as a card with:
 *   - Similarity score badge (0–100 scale)
 *   - Source icon (emoji shorthand — no lucide dep here)
 *   - Capture type pill
 *   - Content preview (truncated at 180 chars)
 *   - Relative date
 *
 * Re-fetches automatically when `query` prop changes (URL-driven).
 * Refetch interval: none — user controls via URL changes.
 */

import { useQuery } from '@tanstack/react-query';
import { searchApi } from '@/lib/api-client';
import type { SearchResult, CaptureSource } from '@/lib/types';
import { Pill } from '@/components/design-system/Pill';

interface SearchResultsProps {
  query: string;
}

// Compact source labels
const SOURCE_LABELS: Record<CaptureSource, string> = {
  slack: 'Slack',
  voice: 'Voice',
  api: 'API',
  document: 'Doc',
  mcp: 'MCP',
  email: 'Email',
  file: 'File',
  consolidation: 'Memory',
  system: 'System',
};

/** Format a score (0–1 float) as a readable percentage badge label. */
function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Determine pill tone based on score value. */
function scoreTone(score: number): 'success' | 'accent' | 'neutral' {
  if (score >= 0.75) return 'success';
  if (score >= 0.5) return 'accent';
  return 'neutral';
}

/** Format ISO date to relative string. */
function relativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

/** Truncate a string to maxLength, appending ellipsis if needed. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}

/** Single result card */
function ResultCard({ result }: { result: SearchResult }) {
  const { capture, score } = result;
  const preview = truncate(capture.content, 180);
  const sourceLabel = SOURCE_LABELS[capture.source] ?? capture.source;

  return (
    <div className="rounded-container border border-cloud-light bg-bg-container p-4 space-y-2 hover:border-cloud-medium transition-colors duration-[120ms]">
      {/* Header row: capture type + score badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Source label */}
          <span className="font-mono text-[10.5px] tracking-[0.04em] uppercase text-text-body-secondary shrink-0">
            {sourceLabel}
          </span>
          {/* Capture type pill */}
          <Pill size="xs" tone="neutral">
            {capture.capture_type}
          </Pill>
          {/* Brain view */}
          <span className="hidden sm:inline font-mono text-[10px] tracking-[0.04em] uppercase text-text-body-secondary truncate">
            {capture.brain_view}
          </span>
        </div>

        {/* Score badge */}
        <Pill size="xs" tone={scoreTone(score)}>
          {formatScore(score)} match
        </Pill>
      </div>

      {/* Content preview */}
      <p className="text-[13px] font-light text-text-body leading-[1.5] whitespace-pre-wrap break-words">
        {preview}
      </p>

      {/* Footer: date + entities */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="flex flex-wrap gap-1">
          {capture.entities?.slice(0, 3).map((e) => (
            <span
              key={e}
              className="font-mono text-[10px] tracking-[0.04em] uppercase text-text-body-secondary bg-ivory-dark px-1.5 py-0.5"
            >
              {e}
            </span>
          ))}
        </div>
        <span className="font-mono text-[10.5px] tracking-[0.04em] text-text-body-secondary shrink-0">
          {relativeDate(capture.created_at)}
        </span>
      </div>
    </div>
  );
}

/** Loading skeletons */
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

export function SearchResults({ query }: SearchResultsProps) {
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

  const results = data?.results ?? [];
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
      {/* Results summary line */}
      <div className="flex items-center justify-between text-[11.5px] font-mono tracking-[0.04em] text-text-body-secondary uppercase">
        <span>
          {total} result{total !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
        </span>
        <span>Hybrid · FTS + vector</span>
      </div>

      {/* Result cards */}
      <div className="space-y-2">
        {results.map((result) => (
          <ResultCard key={result.capture.id} result={result} />
        ))}
      </div>
    </div>
  );
}
