import type { OpenQuestion } from '@/lib/types';

interface OpenQuestionsProps {
  questions: OpenQuestion[];
}

/**
 * OpenQuestions — dashboard right column.
 * 4px priority rail + question text + mono metadata row.
 * Server component.
 */
export function OpenQuestions({ questions }: OpenQuestionsProps) {
  return (
    <div>
      {questions.map((q, i) => {
        const isLast = i === questions.length - 1;
        const isOverdue = q.due === 'overdue';

        return (
          <div
            key={q.id}
            className={[
              'px-[16px] py-[12px] cursor-pointer',
              'transition-[background] duration-[100ms] hover:bg-ivory-dark',
              !isLast ? 'border-b border-cloud-light' : '',
            ].filter(Boolean).join(' ')}
          >
            <div className="flex items-start gap-[10px]">
              {/* Priority rail */}
              <span
                className="w-[4px] self-stretch mt-[2px] mb-[2px] shrink-0 inline-block"
                style={{
                  background: q.priority === 'high'
                    ? 'var(--color-book-cloth)'
                    : 'var(--color-cloud-medium)',
                }}
              />

              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-normal text-text-heading leading-[1.4]">
                  {q.question}
                </div>
                <div className="flex gap-[10px] items-center mt-[6px] font-mono text-[10.5px] text-text-body-secondary tracking-[0.03em]">
                  <span
                    style={{
                      color: isOverdue ? 'var(--color-faded-red)' : undefined,
                    }}
                  >
                    {isOverdue ? 'OVERDUE' : `DUE ${q.due.toUpperCase()}`}
                  </span>
                  <span className="opacity-40">·</span>
                  <span>{q.context.toUpperCase()}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
