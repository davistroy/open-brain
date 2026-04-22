'use client';

import type { MentionsTimelineBucket } from '@/lib/types';

interface MentionsChartProps {
  /**
   * Buckets from the mentions-timeline API response.
   * Each bucket has a period (ISO date) and a count.
   * If undefined, renders with no bars.
   */
  buckets?: MentionsTimelineBucket[];
  /**
   * Total number of buckets to display (zero-fills missing periods).
   * Defaults to 13 (90d / 7 = ~13 weeks).
   */
  totalBuckets?: number;
  firstLabel?: string;
  lastLabel?: string;
}

/**
 * Zero-fill helper: ensures exactly `total` buckets, padding the front
 * with zero-count entries for missing periods. Uses API buckets when
 * available, falling back to an empty array.
 */
function zeroFill(buckets: MentionsTimelineBucket[], total: number): number[] {
  const counts = buckets.map((b) => b.count);
  if (counts.length >= total) {
    // Trim to most recent N buckets
    return counts.slice(-total);
  }
  // Pad with leading zeros
  const padding = total - counts.length;
  return [...Array(padding).fill(0), ...counts];
}

/**
 * Mini bar chart showing mentions over time.
 * Accepts API buckets + zero-fills missing periods client-side.
 * Recent bars (last 5) render in book-cloth; older bars in cloud-dark.
 * Matches 06-entity-detail.html:206-213.
 * Client component.
 */
export function MentionsChart({
  buckets = [],
  totalBuckets = 13,
  firstLabel,
  lastLabel,
}: MentionsChartProps) {
  const values = zeroFill(buckets, totalBuckets);

  // Derive labels from bucket periods when available
  const derivedFirstLabel = firstLabel
    ?? (buckets.length > 0
      ? new Date(buckets[0].period).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).toUpperCase()
      : undefined);
  const derivedLastLabel = lastLabel
    ?? (buckets.length > 0
      ? new Date(buckets[buckets.length - 1].period).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).toUpperCase()
      : undefined);

  const maxVal = Math.max(...values, 1); // avoid division by zero when all zero
  const CHART_HEIGHT = 56;

  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height: CHART_HEIGHT }}>
        {values.map((v, i) => {
          const isRecent = i > values.length - 6;
          const barHeight = v === 0 ? 2 : Math.round((v / maxVal) * CHART_HEIGHT);
          return (
            <div
              key={i}
              className="flex-1"
              style={{
                height: barHeight,
                background: v === 0
                  ? 'var(--color-cloud-light)'
                  : isRecent
                    ? 'var(--color-book-cloth)'
                    : 'var(--color-cloud-dark)',
              }}
            />
          );
        })}
      </div>
      {(derivedFirstLabel || derivedLastLabel) && (
        <div
          className="flex justify-between mt-2 text-text-body-secondary"
          style={{
            fontFamily: 'var(--font-family-monospace)',
            fontSize: 10,
            letterSpacing: '0.03em',
          }}
        >
          <span>{derivedFirstLabel ?? ''}</span>
          <span>{derivedLastLabel ?? ''}</span>
        </div>
      )}
    </div>
  );
}
