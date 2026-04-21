import { Sparkles, FileText, GitMerge, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/design-system';
import { Eyebrow } from '@/components/design-system';
import type { EntityDetail } from '@/lib/types';

interface EntityHeaderProps {
  entity: EntityDetail;
}

/**
 * Hero card for the entity detail page.
 * 3-col grid: 88px monogram | content + stats | stacked actions
 * Matches 06-entity-detail.html:92-126.
 * Server component.
 */
export function EntityHeader({ entity }: EntityHeaderProps) {
  const initials = entity.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={[
        'bg-bg-container border border-cloud-medium',
        'p-7 mb-5',
        'grid gap-6 items-start',
      ].join(' ')}
      style={{ gridTemplateColumns: '88px 1fr auto' }}
    >
      {/* Initials monogram */}
      <div
        className="flex items-center justify-center bg-book-cloth text-ivory-light"
        style={{
          width: 88,
          height: 88,
          fontFamily: 'var(--font-family-display)',
          fontSize: 36,
          fontWeight: 300,
          letterSpacing: '-0.02em',
        }}
        aria-hidden="true"
      >
        {initials}
      </div>

      {/* Name + stats */}
      <div>
        <Eyebrow noMargin className="mb-[6px]">
          {entity.entity_type.toUpperCase()} · ADDED {entity.first_seen.toUpperCase()}
        </Eyebrow>
        <h1
          className="text-text-heading"
          style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 38,
            fontWeight: 300,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
            margin: '4px 0 8px',
          }}
        >
          {entity.name}
        </h1>
        <p
          className="text-text-body font-light"
          style={{ fontSize: 15, maxWidth: 620, lineHeight: 1.55, margin: 0 }}
        >
          {entity.summary.split('.').slice(0, 2).join('.') + '.'}
        </p>

        {/* Stats row */}
        <div className="flex gap-6 mt-4">
          <StatBlock label="MENTIONS" value={String(entity.mention_count)} />
          <StatBlock label="FIRST SEEN" value={entity.first_seen} />
          <StatBlock label="LAST SEEN" value={entity.last_seen ?? '—'} />
          <StatBlock label="CO-MENTIONED" value={`${entity.co_mentioned_count} entities`} />
          <StatBlock label="SENTIMENT" value={entity.sentiment} />
        </div>
      </div>

      {/* Actions column */}
      <div className="flex flex-col gap-[6px]">
        <Button variant="primary" size="sm" icon={<Sparkles size={11} strokeWidth={1.5} />}>
          Ask AI about {entity.name.split(' ')[0]}
        </Button>
        <Button variant="secondary" size="sm" icon={<FileText size={11} strokeWidth={1.5} />}>
          Generate brief
        </Button>
        <Button variant="secondary" size="sm" icon={<GitMerge size={11} strokeWidth={1.5} />}>
          Merge…
        </Button>
        <Button variant="ghost" size="sm" icon={<MoreHorizontal size={11} strokeWidth={1.5} />}>
          More
        </Button>
      </div>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="text-text-body-secondary"
        style={{
          fontFamily: 'var(--font-family-monospace)',
          fontSize: 10.5,
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        className="text-text-heading"
        style={{
          fontFamily: 'var(--font-family-display)',
          fontSize: 18,
          fontWeight: 400,
        }}
      >
        {value}
      </div>
    </div>
  );
}
