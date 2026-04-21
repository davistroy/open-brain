import Link from 'next/link';
import { ArrowRight, Play } from 'lucide-react';
import { Button } from '@/components/design-system';
import type { BriefDetail } from '@/lib/types';

interface BriefHeroProps {
  brief: BriefDetail;
}

const HERO_ITEMS = [
  '3 decisions pending',
  '1 overdue commitment',
  '4 meetings this week',
  '2 new entities',
  '7 low-signal items skipped',
];

/**
 * Featured hero block for the latest/most relevant brief.
 * Warm paper (book-cloth-50) background, 3px left book-cloth rail,
 * 2-col grid: content left | "IN THIS BRIEF" list right.
 * Server component.
 */
export function BriefHero({ brief }: BriefHeroProps) {
  return (
    <div
      className="grid gap-12 mb-[24px] p-[32px_40px] border border-[var(--color-status-accent-border)]"
      style={{
        background: 'var(--color-book-cloth-50)',
        borderLeft: '3px solid var(--color-book-cloth)',
        gridTemplateColumns: '1fr 260px',
      }}
    >
      {/* Left: eyebrow, title, excerpt, actions */}
      <div>
        <div className="font-mono text-[10.5px] text-book-cloth-dark tracking-[0.12em] uppercase mb-[10px]">
          DAILY · TUESDAY, APRIL 21 · 07:00
        </div>
        <h2
          className="font-display text-[34px] font-light tracking-[-0.025em] leading-[1.1] text-text-heading mb-[12px] mt-0"
        >
          {brief.headline}
        </h2>
        <p className="text-[14.5px] font-light leading-[1.6] text-text-body max-w-[620px] m-0">
          The London office budget memo needs a response (2 days overdue). Sarah has pushed
          back on the Q4 eng hiring timeline twice — worth a 15-minute call before Thursday&apos;s
          board. Maya asked about customer exposure last Friday; you haven&apos;t replied.
        </p>
        <div className="flex items-center gap-[8px] mt-[18px]">
          <Link href={`/briefs/${brief.id}`}>
            <Button
              variant="primary"
              size="sm"
              iconRight={<ArrowRight size={12} strokeWidth={2} />}
            >
              Read full brief
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            icon={<Play size={12} strokeWidth={1.5} />}
          >
            Listen · 4 min
          </Button>
          <Button variant="ghost" size="sm">
            Dismiss
          </Button>
        </div>
      </div>

      {/* Right: "IN THIS BRIEF" list */}
      <div>
        <div className="font-mono text-[10.5px] text-book-cloth-dark tracking-[0.12em] uppercase mb-[10px]">
          IN THIS BRIEF
        </div>
        {HERO_ITEMS.map((item) => (
          <div
            key={item}
            className="flex gap-[10px] py-[5px] text-[13px] font-light text-text-body"
          >
            <span className="text-book-cloth shrink-0">→</span>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
