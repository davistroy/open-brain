'use client';

/**
 * TimelineEntry — a single capture row within a TimelineGroup.
 *
 * Layout (Cloudscape-aligned):
 *   [source icon] [brain view dot] [text preview]  [relative timestamp]
 *
 * Source icon: lucide icon mapped from CaptureSource via source-icons.ts.
 * Brain view dot: 8px color circle matching the 5 brain view colors.
 * Text preview: first ~120 chars of content; truncates with ellipsis.
 * Timestamp: relative (e.g. "3h ago", "14:32"); full ISO on hover via title.
 *
 * The component is a client component because it references browser APIs
 * (Date.now()) for relative formatting — rendered in the timeline feed.
 */

import Link from 'next/link';
import { SOURCE_ICON_MAP, SOURCE_LABEL_MAP } from '@/lib/source-icons';
import type { Capture } from '@/lib/types';

// ---------------------------------------------------------------------------
// Brain view color mapping
// ---------------------------------------------------------------------------

const BRAIN_VIEW_COLOR: Record<string, string> = {
  career:        'bg-[#5B8DB8]',   // steel blue
  personal:      'bg-[#7B9E6B]',   // moss green
  technical:     'bg-[#8B7355]',   // brown/book-cloth
  'work-internal': 'bg-[#B8935A]', // amber/terracotta
  client:        'bg-[#9B6B8A]',   // mauve
};

const BRAIN_VIEW_LABEL: Record<string, string> = {
  career:          'Career',
  personal:        'Personal',
  technical:       'Technical',
  'work-internal': 'Work',
  client:          'Client',
};

// ---------------------------------------------------------------------------
// Relative timestamp formatting
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp into a relative or time-only string.
 *   - Same day: "14:32"
 *   - Same week: "Mon 14:32"
 *   - Older:     "Apr 14"
 */
function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();

  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    // Same calendar day — show HH:MM
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  if (diffDays < 7) {
    // Within the past week — "Mon 14:32"
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${dayName} ${time}`;
  }

  // Older — "Apr 14"
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Truncate content to a preview length with ellipsis if needed.
 * Targets ~160 chars, breaking at a word boundary.
 */
function buildPreview(content: string, maxLen = 160): string {
  if (content.length <= maxLen) return content;
  const truncated = content.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 80 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

// ---------------------------------------------------------------------------
// TimelineEntry component
// ---------------------------------------------------------------------------

interface TimelineEntryProps {
  capture: Capture;
}

export function TimelineEntry({ capture }: TimelineEntryProps) {
  const { source, brain_view, content, created_at, capture_type } = capture;

  const Icon = SOURCE_ICON_MAP[source] ?? SOURCE_ICON_MAP.api;
  const sourceLabel = SOURCE_LABEL_MAP[source] ?? source;
  const viewColor = BRAIN_VIEW_COLOR[brain_view] ?? 'bg-cloud-dark';
  const viewLabel = BRAIN_VIEW_LABEL[brain_view] ?? brain_view;
  const preview = buildPreview(content);
  const timestamp = formatTimestamp(created_at);

  return (
    <Link
      href={`/captures/${capture.id}`}
      className={[
        'flex items-start gap-3 px-4 py-[10px]',
        'border-b border-cloud-light last:border-b-0',
        'hover:bg-ivory-dark transition-colors duration-fast',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-book-cloth focus-visible:ring-inset',
        'group',
      ].join(' ')}
      title={new Date(created_at).toLocaleString()}
    >
      {/* Source icon */}
      <div
        className={[
          'flex-shrink-0 mt-[2px]',
          'flex items-center justify-center',
          'w-[28px] h-[28px]',
          'rounded-full bg-ivory-dark border border-cloud-light',
          'text-text-body-secondary group-hover:text-text-heading',
          'transition-colors duration-fast',
        ].join(' ')}
        aria-label={sourceLabel}
        title={sourceLabel}
      >
        <Icon size={13} strokeWidth={1.5} />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Top meta row: capture_type pill + brain view dot + source label */}
        <div className="flex items-center gap-[6px] mb-[3px]">
          {/* Brain view color dot */}
          <span
            className={['w-[7px] h-[7px] rounded-full flex-shrink-0', viewColor].join(' ')}
            title={viewLabel}
          />

          {/* Source label */}
          <span className="font-mono text-[10px] tracking-[0.06em] uppercase text-text-body-secondary">
            {sourceLabel}
          </span>

          {/* Capture type badge */}
          <span
            className={[
              'font-mono text-[10px] tracking-[0.04em] uppercase',
              'px-[5px] py-[1px]',
              'border border-cloud-light bg-ivory-dark text-text-body-secondary',
              'rounded-badge',
            ].join(' ')}
          >
            {capture_type}
          </span>
        </div>

        {/* Text preview */}
        <p
          className={[
            'text-[13px] font-light leading-[1.45]',
            'text-text-body',
            'group-hover:text-text-heading',
            'transition-colors duration-fast',
          ].join(' ')}
        >
          {preview}
        </p>
      </div>

      {/* Timestamp */}
      <div className="flex-shrink-0 text-[11px] font-mono text-text-body-secondary mt-[3px] whitespace-nowrap">
        {timestamp}
      </div>
    </Link>
  );
}
