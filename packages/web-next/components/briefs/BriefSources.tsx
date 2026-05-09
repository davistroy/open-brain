'use client';

import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Card, Eyebrow } from '@/components/design-system';
import { useRefineBrief } from '@/lib/api/briefs.hooks';
import type { BriefSource } from '@/lib/types';

interface BriefSourcesProps {
  briefId: string;
  sources: BriefSource[];
  sourceTotal: number;
  refineOptions: string[];
}

/**
 * Right sidebar for the brief reader page.
 * Two sections:
 *   1. "Grounded in" card — list of BriefSource entries + "Show all N →" footer
 *   2. "REFINE THIS BRIEF" box — clickable refine buttons
 *
 * Refine buttons POST to /api/v1/briefs/:id/refine (async).
 * A "Refining..." toast is shown on click; the new brief arrives via SSE
 * (brief_created event) which auto-invalidates the briefs query key.
 *
 * 'use client' — useMutation + toast require client context.
 */
export function BriefSources({ briefId, sources, sourceTotal, refineOptions }: BriefSourcesProps) {
  const refineMutation = useRefineBrief();

  return (
    <aside className="sticky top-[22px] flex flex-col gap-[16px]">
      {/* Grounded in — source list */}
      <Card
        header="Grounded in"
        description={`${sourceTotal} captures drive this brief`}
        padded={false}
      >
        <div>
          {sources.map((source, i) => (
            <div
              key={i}
              className={[
                'px-[14px] py-[10px]',
                i < sources.length - 1 ? 'border-b border-cloud-light' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="flex justify-between items-baseline">
                <span
                  className="font-mono text-[10px] tracking-[0.08em]"
                  style={{ color: 'var(--color-book-cloth-dark)' }}
                >
                  {source.type}
                </span>
                <span className="font-mono text-[10px] text-text-body-secondary uppercase">
                  {source.date}
                </span>
              </div>
              <div className="text-[12.5px] text-text-heading mt-[3px] font-normal">
                {source.title}
              </div>
            </div>
          ))}

          {sourceTotal > sources.length && (
            <div className="px-[14px] py-[8px] text-center border-t border-cloud-medium">
              <button
                className="text-[12px] font-light text-text-body-secondary hover:text-text-heading bg-transparent border-none cursor-pointer transition-colors duration-[120ms]"
                type="button"
              >
                Show all {sourceTotal} →
              </button>
            </div>
          )}
        </div>
      </Card>

      {/* Refine this brief */}
      <div
        className="border border-cloud-light px-[16px] py-[14px]"
        style={{ background: 'var(--color-ivory-dark)' }}
      >
        <Eyebrow noMargin>REFINE THIS BRIEF</Eyebrow>
        <div className="flex flex-col gap-[6px] mt-[8px]">
          {refineOptions.map((option, i) => {
            const isPending =
              refineMutation.isPending &&
              refineMutation.variables?.instruction === option;
            return (
              <button
                key={i}
                type="button"
                disabled={refineMutation.isPending}
                onClick={() => {
                  toast.loading(`Refining: ${option}…`, { id: `refine-${briefId}` });
                  refineMutation.mutate(
                    { id: briefId, instruction: option },
                    {
                      onSuccess: () => {
                        toast.success('Refinement queued — brief will update when ready', {
                          id: `refine-${briefId}`,
                        });
                      },
                      onError: (err) => {
                        const message =
                          err instanceof Error ? err.message : 'Refinement failed — please try again.';
                        toast.error(message, { id: `refine-${briefId}` });
                      },
                    },
                  );
                }}
                className={[
                  'text-left bg-transparent border-none p-0 py-[4px]',
                  'text-[12.5px] font-light text-text-body',
                  'transition-colors duration-[120ms]',
                  'inline-flex items-center gap-[6px]',
                  refineMutation.isPending
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer hover:text-text-heading',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {isPending && (
                  <Loader2
                    size={11}
                    className="animate-spin shrink-0"
                    aria-hidden="true"
                  />
                )}
                {option}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
