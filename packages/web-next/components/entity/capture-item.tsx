import type { CaptureItem as CaptureItemType } from '@/lib/types';

interface CaptureItemProps {
  capture: CaptureItemType;
  isLast?: boolean;
}

/**
 * Single capture row on the entity detail page.
 * Source eyebrow + time header, then title + snippet.
 * Separated by 1px cloud-light border; last item has no bottom border.
 * Matches 06-entity-detail.html:73-82.
 * Server component.
 */
export function CaptureItem({ capture, isLast = false }: CaptureItemProps) {
  return (
    <div
      className={isLast ? '' : 'border-b border-cloud-light'}
      style={{ padding: '12px 0', cursor: 'pointer' }}
    >
      {/* Meta row: source + time */}
      <div className="flex items-baseline gap-[10px] mb-[2px]">
        <span
          style={{
            fontFamily: 'var(--font-family-monospace)',
            fontSize: 10,
            color: 'var(--color-book-cloth-dark)',
            letterSpacing: '0.08em',
          }}
        >
          {capture.source}
        </span>
        <span
          className="text-text-body-secondary"
          style={{
            fontFamily: 'var(--font-family-monospace)',
            fontSize: 10.5,
            letterSpacing: '0.02em',
          }}
        >
          {capture.time}
        </span>
      </div>

      {/* Title */}
      <div
        className="text-text-heading"
        style={{ fontSize: 13.5, fontWeight: 400, marginBottom: 2 }}
      >
        {capture.title}
      </div>

      {/* Snippet */}
      <div
        className="text-text-body font-light"
        style={{ fontSize: 12.5, lineHeight: 1.55 }}
      >
        {capture.snippet}
      </div>
    </div>
  );
}
