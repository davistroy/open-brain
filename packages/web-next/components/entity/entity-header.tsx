'use client';

import { Sparkles, FileText, GitMerge, MoreHorizontal, Loader2 } from 'lucide-react';
import { Button } from '@/components/design-system';
import { Eyebrow } from '@/components/design-system';
import type { EntityDetail } from '@/lib/types';

interface EntityHeaderProps {
  entity: EntityDetail;
  onAskAI: () => void;
  onMerge: () => void;
  onGenerateBrief: () => void;
  isBriefPending?: boolean;
}

/**
 * Hero card for the entity detail page.
 * 3-col grid: 88px monogram | content + stats | stacked actions
 * Matches 06-entity-detail.html:92-126.
 * Client component (wires modal open callbacks + sonner toasts).
 */
export function EntityHeader({ entity, onAskAI, onMerge, onGenerateBrief, isBriefPending = false }: EntityHeaderProps) {
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
          {entity.entity_type.toUpperCase()} · ADDED {formatDate(entity.first_seen_at).toUpperCase()}
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
        {entity.summary && (
          <p
            className="text-text-body font-light"
            style={{ fontSize: 15, maxWidth: 620, lineHeight: 1.55, margin: 0 }}
          >
            {entity.summary.split('.').slice(0, 2).join('.') + '.'}
          </p>
        )}

        {/* Stats row */}
        <div className="flex gap-6 mt-4">
          <StatBlock label="MENTIONS" value={String(entity.mention_count)} />
          <StatBlock label="FIRST SEEN" value={formatDate(entity.first_seen_at)} />
          <StatBlock label="LAST SEEN" value={entity.last_seen_at ? formatDate(entity.last_seen_at) : '—'} />
          {entity.co_mentioned_count !== undefined && (
            <StatBlock label="CO-MENTIONED" value={`${entity.co_mentioned_count} entities`} />
          )}
          {entity.sentiment && (
            <StatBlock label="SENTIMENT" value={entity.sentiment} />
          )}
        </div>
      </div>

      {/* Actions column */}
      <div className="flex flex-col gap-[6px]">
        <Button
          variant="primary"
          size="sm"
          icon={<Sparkles size={11} strokeWidth={1.5} />}
          onClick={onAskAI}
        >
          Ask AI about {entity.name.split(' ')[0]}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={
            isBriefPending
              ? <Loader2 size={11} strokeWidth={1.5} className="animate-spin" />
              : <FileText size={11} strokeWidth={1.5} />
          }
          onClick={onGenerateBrief}
          disabled={isBriefPending}
        >
          {isBriefPending ? 'Generating…' : 'Generate brief'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<GitMerge size={11} strokeWidth={1.5} />}
          onClick={onMerge}
        >
          Merge…
        </Button>
        <Button variant="ghost" size="sm" icon={<MoreHorizontal size={11} strokeWidth={1.5} />}>
          More
        </Button>
      </div>
    </div>
  );
}

/** Format an ISO 8601 date string for display (e.g. "Apr 21, 2026"). Falls back to raw string. */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
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
