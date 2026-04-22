'use client';

import Link from 'next/link';
import { ArrowRight, Play } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/design-system';
import { briefsApi } from '@/lib/api-client';
import type { Brief } from '@/lib/types';

interface BriefHeroProps {
  brief: Brief;
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
 * Client component — wires Dismiss (POST /briefs/:id/dismiss + router.refresh)
 * and Listen (M3 stub toast).
 */
export function BriefHero({ brief }: BriefHeroProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const dismissMutation = useMutation({
    mutationFn: () => briefsApi.dismiss(brief.id),
    onSuccess: () => {
      toast('Brief dismissed');
      // Invalidate briefs list so the RSC re-fetches without this brief as hero
      queryClient.invalidateQueries({ queryKey: ['briefs'] });
      router.refresh();
    },
    onError: () => {
      toast.error('Could not dismiss brief — please try again.');
    },
  });

  function handleListen() {
    toast('Text-to-speech coming in M3');
  }

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
          {brief.kind} · {brief.generated}
        </div>
        <h2
          className="font-display text-[34px] font-light tracking-[-0.025em] leading-[1.1] text-text-heading mb-[12px] mt-0"
        >
          {brief.title}
        </h2>
        <p className="text-[14.5px] font-light leading-[1.6] text-text-body max-w-[620px] m-0">
          {brief.subtitle}
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
            onClick={handleListen}
          >
            Listen
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dismissMutation.mutate()}
            disabled={dismissMutation.isPending}
          >
            {dismissMutation.isPending ? 'Dismissing…' : 'Dismiss'}
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
