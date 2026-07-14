'use client';

/**
 * GroupedResults — client-side grouped view of search results.
 *
 * Groups SearchResult[] by capture source bucket:
 *   - Captures (voice, api, mcp, slack, system, consolidation)
 *   - Documents (document, file)
 *   - Email
 *
 * Each group: display-font section header (18px, weight 400), mono match
 * count, "View all" link (navigates to search with source filter via query
 * append). Max 4 items per group.
 *
 * Items re-use the ResultCard render logic from SearchResults — extracted here
 * as a shared sub-component so both flat and grouped modes use the same card.
 */

import Link from 'next/link';
import type { SearchResult, CaptureSource } from '@/lib/types';
import { Pill } from '@/components/design-system/Pill';
import { useClientNow } from '@/hooks/useClientNow';

// ---------------------------------------------------------------------------
// Source group definitions
// ---------------------------------------------------------------------------

type GroupKey = 'captures' | 'documents' | 'email';

const GROUP_LABELS: Record<GroupKey, string> = {
  captures:  'Captures',
  documents: 'Documents',
  email:     'Email',
};

const SOURCE_TO_GROUP: Record<CaptureSource, GroupKey> = {
  voice:        'captures',
  api:          'captures',
  mcp:          'captures',
  slack:        'captures',
  system:       'captures',
  consolidation: 'captures',
  document:     'documents',
  file:         'documents',
  email:        'email',
};

/** Ordered display sequence for groups. */
const GROUP_ORDER: GroupKey[] = ['captures', 'documents', 'email'];

// ---------------------------------------------------------------------------
// Compact source labels (shared with SearchResults flat view)
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<CaptureSource, string> = {
  slack:        'Slack',
  voice:        'Voice',
  api:          'API',
  document:     'Doc',
  mcp:          'MCP',
  email:        'Email',
  file:         'File',
  consolidation: 'Memory',
  system:       'System',
};

// ---------------------------------------------------------------------------
// Shared result card (used by both flat and grouped modes)
// ---------------------------------------------------------------------------

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
function relativeDate(iso: string, now: number | null): string {
  const date = new Date(iso);
  // Pre-mount (SSR + first client render): stable absolute date, no `now` dependency.
  if (now === null) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const diffMs = now - date.getTime();
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

/**
 * ResultCard — single search result row. Exported so SearchResults
 * flat mode can also use this canonical card definition.
 */
export function ResultCard({ result }: { result: SearchResult }) {
  const { capture, score } = result;
  const now = useClientNow();
  const preview = truncate(capture.content, 180);
  const sourceLabel = SOURCE_LABELS[capture.source] ?? capture.source;

  return (
    <Link
      href={`/captures/${capture.id}`}
      className="block rounded-container border border-cloud-light bg-bg-container p-4 space-y-2 hover:border-cloud-medium transition-colors duration-[120ms] focus:outline-none focus-visible:ring-2 focus-visible:ring-book-cloth"
    >
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

      {/* Footer: entity pills + date */}
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
          {relativeDate(capture.created_at, now)}
        </span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Grouping logic
// ---------------------------------------------------------------------------

interface ResultGroup {
  key: GroupKey;
  label: string;
  results: SearchResult[];
}

function groupResults(results: SearchResult[]): ResultGroup[] {
  const buckets = new Map<GroupKey, SearchResult[]>();

  for (const result of results) {
    const groupKey = SOURCE_TO_GROUP[result.capture.source] ?? 'captures';
    const bucket = buckets.get(groupKey) ?? [];
    bucket.push(result);
    buckets.set(groupKey, bucket);
  }

  return GROUP_ORDER
    .filter((key) => buckets.has(key))
    .map((key) => ({
      key,
      label: GROUP_LABELS[key],
      results: buckets.get(key)!,
    }));
}

// ---------------------------------------------------------------------------
// GroupedResults component
// ---------------------------------------------------------------------------

const MAX_PER_GROUP = 4;

interface GroupedResultsProps {
  results: SearchResult[];
  query: string;
}

export function GroupedResults({ results, query }: GroupedResultsProps) {
  const groups = groupResults(results);

  if (groups.length === 0) return null;

  return (
    <div className="space-y-8">
      {groups.map((group) => {
        const shown = group.results.slice(0, MAX_PER_GROUP);
        const overflow = group.results.length - MAX_PER_GROUP;
        const viewAllParams = new URLSearchParams({ q: query });

        return (
          <section key={group.key} aria-label={group.label}>
            {/* Group header */}
            <div className="flex items-baseline gap-3 mb-3">
              <h2 className="font-display text-[18px] font-normal tracking-[-0.01em] text-text-heading">
                {group.label}
              </h2>
              <span className="font-mono text-[11px] tracking-[0.05em] uppercase text-text-body-secondary">
                {group.results.length} match{group.results.length !== 1 ? 'es' : ''}
              </span>
            </div>

            {/* Result cards — max 4 */}
            <div className="space-y-2">
              {shown.map((result) => (
                <ResultCard key={result.capture.id} result={result} />
              ))}
            </div>

            {/* "View all" link when there are more than 4 */}
            {overflow > 0 && (
              <div className="mt-2">
                <Link
                  href={`/search?${viewAllParams.toString()}`}
                  className={[
                    'inline-flex items-center gap-1',
                    'font-mono text-[11px] tracking-[0.04em] uppercase',
                    'text-book-cloth hover:text-book-cloth-dark',
                    'transition-colors duration-[100ms]',
                    'border-b border-book-cloth hover:border-book-cloth-dark',
                    'pb-[1px]',
                  ].join(' ')}
                >
                  View all {group.results.length} in {group.label.toLowerCase()}
                </Link>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
