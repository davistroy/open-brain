import { Card, Eyebrow } from '@/components/design-system';
import type { BriefSource } from '@/lib/types';

interface BriefSourcesProps {
  sources: BriefSource[];
  sourceTotal: number;
  refineOptions: string[];
}

/**
 * Right sidebar for the brief reader page.
 * Two sections:
 *   1. "Grounded in" card — list of BriefSource entries + "Show all N →" footer
 *   2. "REFINE THIS BRIEF" box — plain text buttons (ivory-dark bg)
 *
 * Sources are displayed with type label and date; not linked in M1.
 * Server component.
 */
export function BriefSources({ sources, sourceTotal, refineOptions }: BriefSourcesProps) {
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
          {refineOptions.map((option, i) => (
            <button
              key={i}
              type="button"
              className="text-left bg-transparent border-none p-0 py-[4px] text-[12.5px] font-light text-text-body cursor-pointer hover:text-text-heading transition-colors duration-[120ms]"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
