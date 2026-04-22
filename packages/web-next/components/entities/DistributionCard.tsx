import { Card } from '@/components/design-system';
import type { Entity } from '@/lib/types';

interface DistributionCardProps {
  entities: Entity[];
}

/** Display label and accent color keyed by entity_type */
const TYPE_META: Record<string, { label: string; tone: string }> = {
  person:   { label: 'People',        tone: 'var(--color-book-cloth)' },
  project:  { label: 'Projects',      tone: 'var(--color-slate-medium)' },
  topic:    { label: 'Topics',        tone: 'var(--color-cloud-dark)' },
  org:      { label: 'Organizations', tone: 'var(--color-amber-warm)' },
  decision: { label: 'Decisions',     tone: 'var(--color-text-body)' },
};

const TYPE_ORDER = ['person', 'project', 'topic', 'org', 'decision'] as const;

/**
 * Entity type distribution bar chart.
 * Derives counts by reducing over the entities prop (no separate API call).
 * Bar width is relative to the max count in the list.
 * Server component.
 */
export function DistributionCard({ entities }: DistributionCardProps) {
  // Compute per-type counts from entities array
  const counts: Record<string, number> = {};
  for (const entity of entities) {
    counts[entity.entity_type] = (counts[entity.entity_type] ?? 0) + 1;
  }

  const distribution = TYPE_ORDER
    .map((type) => ({
      type,
      label: TYPE_META[type]?.label ?? type,
      tone: TYPE_META[type]?.tone ?? 'var(--color-cloud-dark)',
      count: counts[type] ?? 0,
    }))
    .filter((d) => d.count > 0);

  const maxCount = distribution.length > 0
    ? Math.max(...distribution.map((d) => d.count))
    : 1;

  if (distribution.length === 0) {
    return (
      <Card header="Distribution" padded>
        <p className="text-[12px] text-text-body-secondary font-light">No entities loaded.</p>
      </Card>
    );
  }

  return (
    <Card header="Distribution" padded>
      <div className="flex flex-col gap-[10px]">
        {distribution.map((d) => (
          <div key={d.type}>
            <div className="flex justify-between text-[12px] text-text-body mb-[4px]">
              <span className="font-light">{d.label}</span>
              <span className="font-mono">{d.count}</span>
            </div>
            <div className="h-[3px] bg-cloud-light relative">
              <div
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${(d.count / maxCount) * 100}%`,
                  background: d.tone,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
