import { Card } from '@/components/design-system';
import type { RelatedEntity } from '@/lib/types';

interface RelatedEntitiesProps {
  entities: RelatedEntity[];
}

/**
 * Sidebar list of related entities with type eyebrow, name, and shared count.
 * Matches 06-entity-detail.html:218-236.
 * Server component.
 */
export function RelatedEntities({ entities }: RelatedEntitiesProps) {
  return (
    <Card header="Also related" padded={false}>
      {entities.map((r, i) => (
        <div
          key={r.id}
          className={[
            'flex justify-between items-center px-4 py-[10px] cursor-pointer',
            'hover:bg-ivory-dark transition-colors duration-[120ms]',
            i < entities.length - 1 ? 'border-b border-cloud-light' : '',
          ].join(' ')}
        >
          <div>
            {/* Type label */}
            <div
              style={{
                fontFamily: 'var(--font-family-monospace)',
                fontSize: 9.5,
                color: 'var(--color-book-cloth-dark)',
                letterSpacing: '0.08em',
              }}
            >
              {r.entity_type.toUpperCase()}
            </div>
            {/* Name */}
            <div
              className="text-text-heading"
              style={{ fontSize: 13, fontWeight: 400 }}
            >
              {r.name}
            </div>
          </div>

          {/* Shared count */}
          <span
            className="text-text-body-secondary"
            style={{
              fontFamily: 'var(--font-family-monospace)',
              fontSize: 10.5,
            }}
          >
            {r.shared_count} SHARED
          </span>
        </div>
      ))}
    </Card>
  );
}
