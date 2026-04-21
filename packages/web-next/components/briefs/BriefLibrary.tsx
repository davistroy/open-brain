'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  LayoutGrid,
  List,
  Sunrise,
  Calendar,
  UserRound,
  Scale,
  FolderKanban,
  ArrowRight,
} from 'lucide-react';
import { Eyebrow, Card } from '@/components/design-system';
import { BriefCard } from './BriefCard';
import type { Brief, BriefKind } from '@/lib/types';

// ---------------------------------------------------------------------------
// Filter tabs config
// ---------------------------------------------------------------------------

const FILTER_TABS: { id: string; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'DAILY',    label: 'Daily' },
  { id: 'WEEKLY',   label: 'Weekly' },
  { id: 'DOSSIER',  label: 'Dossiers' },
  { id: 'DECISION', label: 'Decisions' },
  { id: 'PROJECT',  label: 'Projects' },
];

// ---------------------------------------------------------------------------
// Icon helper for list view
// ---------------------------------------------------------------------------

const KIND_DOT: Record<BriefKind, string> = {
  DAILY:    'var(--color-book-cloth)',
  WEEKLY:   'var(--color-slate-medium)',
  DOSSIER:  'var(--color-book-cloth-dark)',
  DECISION: '#5E8F4A',
  PROJECT:  'var(--color-cloud-dark)',
};

function ListKindIcon({ kind }: { kind: BriefKind }) {
  const color = KIND_DOT[kind];
  const props = { size: 12, strokeWidth: 1.4, color };
  switch (kind) {
    case 'DAILY':    return <Sunrise {...props} />;
    case 'WEEKLY':   return <Calendar {...props} />;
    case 'DOSSIER':  return <UserRound {...props} />;
    case 'DECISION': return <Scale {...props} />;
    case 'PROJECT':  return <FolderKanban {...props} />;
  }
}

// ---------------------------------------------------------------------------
// BriefLibrary — filter + grid/list toggle
// ---------------------------------------------------------------------------

interface BriefLibraryProps {
  briefs: Brief[];
}

/**
 * Library section: segmented filter tabs + grid/list view toggle.
 * Filters briefs by kind; renders BriefCard grid or compact table list.
 * Client component (owns view + filter state).
 */
export function BriefLibrary({ briefs }: BriefLibraryProps) {
  const [filter, setFilter] = useState<string>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  const visible =
    filter === 'all'
      ? briefs
      : briefs.filter((b) => b.kind === filter);

  return (
    <div>
      {/* Toolbar: LIBRARY eyebrow | filter tabs | view toggle */}
      <div className="flex items-center gap-[12px] mb-[14px]">
        <Eyebrow noMargin>LIBRARY</Eyebrow>
        <div className="flex-1" />

        {/* Filter tabs */}
        <div className="flex border border-cloud-medium">
          {FILTER_TABS.map((tab, i) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={[
                'px-[12px] py-[4px] text-[12px] text-text-body cursor-pointer',
                'font-body border-none',
                i !== FILTER_TABS.length - 1 ? 'border-r border-cloud-medium' : '',
                filter === tab.id
                  ? 'bg-ivory-dark font-normal'
                  : 'bg-transparent font-light',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="flex border border-cloud-medium">
          <button
            onClick={() => setView('grid')}
            aria-label="Grid view"
            className={[
              'px-[10px] py-[4px] inline-flex items-center border-r border-cloud-medium cursor-pointer border-none',
              view === 'grid' ? 'bg-ivory-dark' : 'bg-transparent',
            ].join(' ')}
          >
            <LayoutGrid size={13} strokeWidth={1.5} className="text-text-body" />
          </button>
          <button
            onClick={() => setView('list')}
            aria-label="List view"
            className={[
              'px-[10px] py-[4px] inline-flex items-center cursor-pointer border-none',
              view === 'list' ? 'bg-ivory-dark' : 'bg-transparent',
            ].join(' ')}
          >
            <List size={13} strokeWidth={1.5} className="text-text-body" />
          </button>
        </div>
      </div>

      {/* Grid view */}
      {view === 'grid' && (
        <div className="grid grid-cols-3 gap-[16px]">
          {visible.map((brief) => (
            <BriefCard key={brief.id} brief={brief} />
          ))}
          {visible.length === 0 && (
            <div className="col-span-3 py-[48px] text-center text-[13px] text-text-body-secondary font-light">
              No briefs match this filter.
            </div>
          )}
        </div>
      )}

      {/* List view */}
      {view === 'list' && (
        <Card padded={false}>
          {/* Header row */}
          <div
            className="grid gap-[16px] px-[18px] py-[10px] font-mono text-[10px] tracking-[0.08em] text-text-body-secondary border-b border-cloud-medium"
            style={{ gridTemplateColumns: '90px 1fr 220px 140px 30px' }}
          >
            <span>KIND</span>
            <span>TITLE</span>
            <span>SUMMARY</span>
            <span>GENERATED</span>
            <span />
          </div>

          {visible.length === 0 && (
            <div className="py-[48px] text-center text-[13px] text-text-body-secondary font-light">
              No briefs match this filter.
            </div>
          )}

          {visible.map((brief, i) => (
            <Link
              key={brief.id}
              href={`/briefs/${brief.id}`}
              className={[
                'grid gap-[16px] px-[18px] py-[12px] items-center relative',
                'hover:bg-ivory-dark transition-colors duration-[80ms]',
                'no-underline text-inherit',
                i !== visible.length - 1 ? 'border-b border-cloud-light' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ gridTemplateColumns: '90px 1fr 220px 140px 30px' }}
            >
              {/* Unread dot */}
              {!brief.read && (
                <span
                  className="absolute left-[6px] top-1/2 -translate-y-1/2 w-[4px] h-[4px]"
                  style={{ background: 'var(--color-book-cloth)' }}
                />
              )}

              {/* Kind icon + label */}
              <div className="flex items-center gap-[6px]">
                <ListKindIcon kind={brief.kind} />
                <span className="font-mono text-[10px] text-book-cloth-dark tracking-[0.08em]">
                  {brief.kind}
                </span>
              </div>

              {/* Title */}
              <div
                className={[
                  'text-[13.5px] text-text-heading',
                  brief.read ? 'font-light' : 'font-normal',
                ].join(' ')}
              >
                {brief.title}
              </div>

              {/* Subtitle */}
              <div className="text-[12.5px] text-text-body-secondary font-light">
                {brief.subtitle}
              </div>

              {/* Generated */}
              <div className="font-mono text-[11px] text-text-body-secondary tracking-[0.02em] uppercase">
                {brief.generated}
              </div>

              {/* Arrow */}
              <ArrowRight size={13} strokeWidth={1.5} className="text-cloud-dark" />
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
