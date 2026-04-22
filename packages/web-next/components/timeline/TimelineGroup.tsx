/**
 * TimelineGroup — a date-grouped section of timeline entries.
 *
 * Renders a date header followed by a list of TimelineEntry rows.
 * Date headers use human-friendly labels:
 *   "Today"       — when the group date equals today's date
 *   "Yesterday"   — one day behind today
 *   "Mon Apr 14"  — older dates (weekday + month + day)
 *
 * This is a server component (no 'use client') — receives pre-grouped data
 * from the parent TimelineClient which handles fetching.
 */

import { TimelineEntry } from './TimelineEntry';
import type { Capture } from '@/lib/types';

// ---------------------------------------------------------------------------
// Date header formatting
// ---------------------------------------------------------------------------

/**
 * Format a YYYY-MM-DD group key into a human-friendly date header.
 * Comparison is against today's local date (no time zone adjustment needed —
 * group keys are already in local date space from the groupCaptures fn).
 */
export function formatGroupHeader(dateKey: string): string {
  // Parse as local date (YYYY-MM-DD) — add T00:00 to avoid UTC offset issues
  const groupDate = new Date(`${dateKey}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (groupDate.getTime() === today.getTime()) {
    return 'Today';
  }

  if (groupDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  // Older: "Mon Apr 14"
  return groupDate.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// TimelineGroup component
// ---------------------------------------------------------------------------

interface TimelineGroupProps {
  /** YYYY-MM-DD date key used to generate the section header. */
  dateKey: string;
  captures: Capture[];
}

export function TimelineGroup({ dateKey, captures }: TimelineGroupProps) {
  const header = formatGroupHeader(dateKey);

  if (captures.length === 0) return null;

  return (
    <section aria-label={header}>
      {/* Date header */}
      <div
        className={[
          'sticky top-0 z-10',
          'px-4 py-[6px]',
          'bg-ivory-dark border-y border-cloud-light',
          'flex items-center gap-3',
        ].join(' ')}
      >
        <span className="font-mono text-[11px] tracking-[0.06em] uppercase text-text-body-secondary font-medium">
          {header}
        </span>
        <span
          className={[
            'font-mono text-[10px] tracking-[0.02em]',
            'text-text-body-secondary',
            'px-[6px] py-[1px]',
            'border border-cloud-light bg-bg-container rounded-badge',
          ].join(' ')}
        >
          {captures.length}
        </span>
      </div>

      {/* Entry list */}
      <div className="bg-bg-container">
        {captures.map((capture) => (
          <TimelineEntry key={capture.id} capture={capture} />
        ))}
      </div>
    </section>
  );
}
