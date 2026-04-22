'use client';

/**
 * TimelineFilters — URL-driven brain_view tabs + source filter dropdown.
 *
 * Both filters update the URL via Link (no client-side state) so the page
 * correctly rehydrates on load, browser back/forward works, and the RSC
 * initial fetch picks up the active filters from searchParams.
 *
 * Brain view tabs: "All" + 5 brain views — horizontal pill tabs.
 * Source filter: single-select dropdown over all 9 CaptureSource values.
 *
 * URL params:
 *   ?view=career   — filters by brain_view (omit for "All")
 *   ?source=slack  — filters by source (omit for all sources)
 *   Pagination resets to offset=0 on filter change (omit offset param).
 */

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ALL_SOURCES, SOURCE_LABEL_MAP } from '@/lib/source-icons';
import type { BrainView, CaptureSource } from '@/lib/types';

// ---------------------------------------------------------------------------
// Brain view definitions
// ---------------------------------------------------------------------------

const BRAIN_VIEWS: Array<{ value: BrainView | null; label: string }> = [
  { value: null,            label: 'All' },
  { value: 'career',        label: 'Career' },
  { value: 'personal',      label: 'Personal' },
  { value: 'technical',     label: 'Technical' },
  { value: 'work-internal', label: 'Work' },
  { value: 'client',        label: 'Client' },
];

// ---------------------------------------------------------------------------
// Utility: build a modified query string with one param changed
// ---------------------------------------------------------------------------

function buildFilterUrl(
  pathname: string,
  searchParams: URLSearchParams,
  key: string,
  value: string | null,
): string {
  const params = new URLSearchParams(searchParams.toString());

  if (value === null || value === '') {
    params.delete(key);
  } else {
    params.set(key, value);
  }

  // Always reset pagination on filter change
  params.delete('offset');

  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

// ---------------------------------------------------------------------------
// Brain view tab
// ---------------------------------------------------------------------------

interface ViewTabProps {
  label: string;
  href: string;
  active: boolean;
}

function ViewTab({ label, href, active }: ViewTabProps) {
  return (
    <Link
      href={href}
      className={[
        'inline-flex items-center px-3 py-[5px]',
        'text-[12px] font-mono tracking-[0.04em]',
        'border-b-2 transition-colors duration-fast',
        active
          ? 'border-b-slate-dark text-text-heading font-medium'
          : 'border-b-transparent text-text-body-secondary hover:text-text-heading hover:border-b-cloud-dark',
      ].join(' ')}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// TimelineFilters — main export
// ---------------------------------------------------------------------------

interface TimelineFiltersProps {
  currentView: BrainView | null;
  currentSource: CaptureSource | null;
}

export function TimelineFilters({ currentView, currentSource }: TimelineFiltersProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsObj = new URLSearchParams(searchParams.toString());

  function handleSourceChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value as CaptureSource | '';
    const url = buildFilterUrl(pathname, searchParamsObj, 'source', val === '' ? null : val);
    window.location.href = url;
  }

  return (
    <div
      className={[
        'flex items-center justify-between gap-4',
        'border-b border-cloud-light',
        'bg-bg-container',
      ].join(' ')}
    >
      {/* Brain view tabs — left side */}
      <nav className="flex items-end gap-0" aria-label="Brain view filter">
        {BRAIN_VIEWS.map(({ value, label }) => {
          const href = buildFilterUrl(pathname, searchParamsObj, 'view', value);
          const active = currentView === value || (value === null && currentView === null);
          return (
            <ViewTab key={label} label={label} href={href} active={active} />
          );
        })}
      </nav>

      {/* Source filter — right side */}
      <div className="flex items-center gap-2 pr-1">
        <span className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary">
          Source
        </span>
        <div className="relative">
          <select
            className={[
              'appearance-none',
              'font-mono text-[12px] tracking-[0.03em]',
              'px-[10px] py-[4px] pr-[22px]',
              'border border-cloud-light bg-bg-container',
              'text-text-body',
              'rounded-none',
              'focus:outline-none focus:border-border-input-focused',
              'transition-colors duration-fast cursor-pointer',
            ].join(' ')}
            value={currentSource ?? ''}
            onChange={handleSourceChange}
            aria-label="Filter by source"
          >
            <option value="">All sources</option>
            {ALL_SOURCES.map((src) => (
              <option key={src} value={src}>
                {SOURCE_LABEL_MAP[src]}
              </option>
            ))}
          </select>
          {/* Chevron indicator */}
          <div className="pointer-events-none absolute inset-y-0 right-[6px] flex items-center text-text-body-secondary">
            <svg width="9" height="5" viewBox="0 0 9 5" fill="none">
              <path d="M1 1L4.5 4.5L8 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
