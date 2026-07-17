import Link from 'next/link';
import { Card } from '@/components/design-system';
import type { RelatedCapture } from '@/lib/types';

interface RelatedCapturesProps {
  related: RelatedCapture[];
}

/**
 * Sidebar list of related captures found via spreading activation over the
 * entity graph (#71). Server component; each row links to that capture's detail.
 *
 * Renders a graceful empty state — hop-2 traversal is data-gated on
 * entity_relationships (currently sparse), so "related" may legitimately be
 * empty for a given capture.
 */
export function RelatedCaptures({ related }: RelatedCapturesProps) {
  if (related.length === 0) {
    return (
      <Card header="Related captures" padded>
        <p className="text-text-body-secondary" style={{ fontSize: 13 }}>
          No related captures yet.
        </p>
      </Card>
    );
  }

  return (
    <Card header="Related captures" padded={false}>
      {related.map((r, i) => {
        const content = r.capture.content ?? '';
        const preview = content.slice(0, 120);
        return (
          <Link
            key={r.capture.id}
            href={`/captures/${r.capture.id}`}
            className={[
              'block px-4 py-[10px] cursor-pointer no-underline',
              'hover:bg-ivory-dark transition-colors duration-[120ms]',
              i < related.length - 1 ? 'border-b border-cloud-light' : '',
            ].join(' ')}
          >
            {/* Type + hop eyebrow */}
            <div
              className="flex justify-between items-center"
              style={{
                fontFamily: 'var(--font-family-monospace)',
                fontSize: 9.5,
                color: 'var(--color-book-cloth-dark)',
                letterSpacing: '0.08em',
              }}
            >
              <span>{r.capture.capture_type.toUpperCase()}</span>
              {typeof r.hopCount === 'number' && (
                <span className="text-text-body-secondary">
                  {r.hopCount} HOP{r.hopCount === 1 ? '' : 'S'}
                </span>
              )}
            </div>
            {/* Content preview */}
            <div
              className="text-text-heading"
              style={{ fontSize: 13, fontWeight: 400 }}
            >
              {preview}
              {content.length > 120 ? '…' : ''}
            </div>
          </Link>
        );
      })}
    </Card>
  );
}
