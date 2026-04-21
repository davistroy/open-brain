import type { UpcomingBrief } from '@/lib/types';

interface UpcomingBriefsProps {
  briefs: UpcomingBrief[];
}

/**
 * UpcomingBriefs — dashboard right column progress list.
 * Each brief: title + due date, 2px progress bar, mono stats.
 * Server component.
 */
export function UpcomingBriefs({ briefs }: UpcomingBriefsProps) {
  return (
    <div>
      {briefs.map((brief, i) => {
        const isLast = i === briefs.length - 1;

        return (
          <div
            key={brief.id}
            className={[
              'px-[16px] py-[12px]',
              !isLast ? 'border-b border-cloud-light' : '',
            ].filter(Boolean).join(' ')}
          >
            {/* Title + due */}
            <div className="flex items-baseline justify-between gap-[8px]">
              <div className="text-[13px] font-normal text-text-heading truncate flex-1 min-w-0">
                {brief.title}
              </div>
              <div className="font-mono text-[10.5px] text-text-body-secondary tracking-[0.03em] shrink-0">
                {brief.due.toUpperCase()}
              </div>
            </div>

            {/* Progress bar */}
            <div className="relative h-[2px] bg-cloud-light mt-[10px]">
              <div
                className="absolute inset-y-0 left-0 bg-book-cloth"
                style={{ width: `${brief.progress}%` }}
              />
            </div>

            {/* Meta row */}
            <div className="flex justify-between mt-[6px] font-mono text-[10.5px] text-text-body-secondary tracking-[0.03em]">
              <span>{brief.progress}% SYNTHESIZED</span>
              <span>{brief.source_count} SOURCES</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
