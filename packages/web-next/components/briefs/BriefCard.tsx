import Link from 'next/link';
import { Sunrise, Calendar, UserRound, Scale, FolderKanban, ArrowRight } from 'lucide-react';
import type { Brief, BriefCover, BriefKind } from '@/lib/types';

/** Visual scheme for the 64px color rail — keyed on canonical BriefCover values */
const COVER_SCHEME: Record<
  BriefCover,
  { bg: string; fg: string; mark: string }
> = {
  parchment: { bg: 'var(--color-book-cloth-50)',  fg: 'var(--color-book-cloth-dark)', mark: '◐' },
  evening:   { bg: 'var(--color-slate-medium)',    fg: 'var(--color-ivory-light)',     mark: '▤' },
  canvas:    { bg: 'var(--color-clay)',            fg: 'var(--color-ivory-light)',     mark: '◉' },
  gold:      { bg: 'var(--color-book-cloth)',      fg: 'var(--color-ivory-light)',     mark: '?' },
  slate:     { bg: 'var(--color-moss)',            fg: 'var(--color-ivory-light)',     mark: '▦' },
  sunrise:   { bg: 'var(--color-cloud-medium)',    fg: 'var(--color-text-heading)',    mark: '◑' },
};

/** Icon component per kind */
function KindIcon({ kind, fg }: { kind: BriefKind; fg: string }) {
  const props = { size: 15, strokeWidth: 1.3, color: fg };
  switch (kind) {
    case 'DAILY':    return <Sunrise {...props} />;
    case 'WEEKLY':   return <Calendar {...props} />;
    case 'MONTHLY':  return <Calendar {...props} />;
    case 'DOSSIER':  return <UserRound {...props} />;
    case 'DECISION': return <Scale {...props} />;
    case 'PROJECT':  return <FolderKanban {...props} />;
    default:         return <Calendar {...props} />;
  }
}

interface BriefCardProps {
  brief: Brief;
}

/**
 * Brief card for the library grid.
 * 2-col: 64px color rail (icon + faded glyph) | content area.
 * Hard corners. Border darkens on hover.
 * Server component (hover handled via Tailwind group).
 */
export function BriefCard({ brief }: BriefCardProps) {
  const scheme = COVER_SCHEME[brief.cover];

  return (
    <Link
      href={`/briefs/${brief.id}`}
      className="group flex border border-cloud-light hover:border-cloud-dark transition-[border-color] duration-[120ms] bg-bg-container no-underline"
      style={{ display: 'grid', gridTemplateColumns: '64px 1fr' }}
    >
      {/* Color rail */}
      <div
        className="flex flex-col items-center justify-between py-[12px] px-0 relative"
        style={{ background: scheme.bg }}
      >
        <KindIcon kind={brief.kind} fg={scheme.fg} />
        <span
          className="font-display text-[36px] font-light leading-[1] select-none"
          style={{ color: scheme.fg, opacity: 0.35 }}
        >
          {scheme.mark}
        </span>
      </div>

      {/* Content */}
      <div className="px-[16px] pt-[12px] pb-[14px] min-w-0 relative">
        {/* Kind + unread dot */}
        <div className="flex items-baseline justify-between gap-[8px] mb-[6px]">
          <span className="font-mono text-[10px] text-book-cloth-dark tracking-[0.12em]">
            {brief.kind}
          </span>
          {!brief.read && (
            <span
              className="w-[6px] h-[6px] shrink-0"
              style={{ background: 'var(--color-book-cloth)', display: 'inline-block' }}
            />
          )}
        </div>

        {/* Title */}
        <div className="font-display text-[17px] font-normal tracking-[-0.01em] text-text-heading leading-[1.25] mb-[4px]">
          {brief.title}
        </div>

        {/* Subtitle */}
        <div className="text-[12.5px] text-text-body-secondary font-light leading-[1.5]">
          {brief.subtitle}
        </div>

        {/* Footer: generated timestamp + arrow */}
        <div className="flex items-center justify-between mt-[10px] pt-[8px] border-t border-cloud-light">
          <span className="font-mono text-[10.5px] text-text-body-secondary tracking-[0.03em] uppercase">
            {brief.generated}
          </span>
          <ArrowRight size={13} strokeWidth={1.5} className="text-cloud-dark" />
        </div>
      </div>
    </Link>
  );
}
