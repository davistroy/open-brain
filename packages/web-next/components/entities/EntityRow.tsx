import Link from 'next/link';
import { UserRound, FolderKanban, Hash, Building2, Gavel, ChevronRight, MapPin, Wrench, type LucideIcon } from 'lucide-react';
import { Pill } from '@/components/design-system';
import type { Entity, EntityType } from '@/lib/types';

// ---------------------------------------------------------------------------
// Type meta — icon + label per entity_type
// ---------------------------------------------------------------------------

const TYPE_META: Record<EntityType, { label: string; Icon: LucideIcon }> = {
  person:   { label: 'PERSON',   Icon: UserRound },
  project:  { label: 'PROJECT',  Icon: FolderKanban },
  topic:    { label: 'TOPIC',    Icon: Hash },
  org:      { label: 'ORG',      Icon: Building2 },
  decision: { label: 'DECISION', Icon: Gavel },
  concept:  { label: 'CONCEPT',  Icon: Hash },
  place:    { label: 'PLACE',    Icon: MapPin },
  tool:     { label: 'TOOL',     Icon: Wrench },
};

interface EntityRowProps {
  entity: Entity;
  isLast: boolean;
}

/**
 * Single entity table row — links to /entities/[id].
 * Columns: icon | name/type/blurb | related pills | mentions+trend | last seen | chevron.
 * Server component (Link handles navigation; hover is CSS-only).
 */
export function EntityRow({ entity, isLast }: EntityRowProps) {
  const meta = TYPE_META[entity.entity_type] ?? { label: entity.entity_type.toUpperCase(), Icon: Hash };
  const Icon = meta.Icon;

  const trendColor =
    entity.trend === '▲'
      ? 'var(--color-success)'
      : entity.trend === '▼'
      ? 'var(--color-faded-red)'
      : 'var(--color-text-body-secondary)';

  return (
    <Link
      href={`/entities/${entity.id}`}
      className={[
        'grid items-center gap-[16px] px-[18px] py-[12px]',
        'group cursor-pointer no-underline',
        'hover:bg-ivory-dark transition-colors duration-[120ms]',
        !isLast ? 'border-b border-cloud-light' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ gridTemplateColumns: '20px 240px 1fr 90px 90px 28px' }}
    >
      {/* Col 1 — type icon */}
      <Icon
        size={14}
        strokeWidth={1.4}
        className="text-text-body shrink-0"
      />

      {/* Col 2 — type chip + name + blurb */}
      <div className="min-w-0">
        <span className="font-mono text-[10px] text-book-cloth-dark tracking-[0.08em] uppercase leading-none">
          {meta.label}
        </span>
        <div className="text-[13.5px] font-normal text-text-heading mt-[2px] truncate">
          {entity.name}
        </div>
        {entity.blurb && (
          <div className="text-[12px] font-light text-text-body-secondary mt-[2px] truncate">
            {entity.blurb}
          </div>
        )}
      </div>

      {/* Col 3 — related entity pills */}
      <div className="flex gap-[4px] flex-wrap">
        {(entity.related ?? []).map((r) => (
          <Pill key={r} tone="neutral" size="xs">
            {r}
          </Pill>
        ))}
      </div>

      {/* Col 4 — mention count + trend */}
      <div
        className="font-mono text-[12px] text-text-heading"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {entity.mention_count}{' '}
        {entity.trend && (
          <span style={{ color: trendColor, marginLeft: 4 }}>{entity.trend}</span>
        )}
      </div>

      {/* Col 5 — last seen */}
      <div className="font-mono text-[11px] text-text-body-secondary tracking-[0.02em] uppercase">
        {entity.last_seen ?? '—'}
      </div>

      {/* Col 6 — chevron */}
      <ChevronRight
        size={14}
        strokeWidth={1.5}
        className="text-cloud-dark shrink-0"
      />
    </Link>
  );
}
