'use client';

import { useState, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/design-system';
import { synthesizeApi } from '@/lib/api-client';

interface FollowUpAnswer {
  question: string;
  answer: string;
  capture_count: number;
}

interface BriefFollowUpProps {
  /** Brief title used as display context in the answer header. */
  briefTitle: string;
}

/**
 * Inline follow-up question panel rendered below the TOC action group.
 *
 * Click "Ask follow-up" → text input expands. Submit → calls
 * POST /api/v1/synthesize with the question. Answer appends in a
 * book-cloth-50 card below previous answers. Supports multiple
 * sequential questions (accumulating history).
 *
 * Loading: shimmer animation on placeholder card.
 * Error: sonner toast — UI stays open so the user can retry.
 * 'use client' — all state is interactive.
 */
export function BriefFollowUp({ briefTitle }: BriefFollowUpProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answers, setAnswers] = useState<FollowUpAnswer[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleToggle() {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        // Focus input after transition tick
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      return next;
    });
  }

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const q = question.trim();
    if (!q || loading) return;

    setLoading(true);
    const pendingQuestion = q;
    setQuestion('');

    try {
      const result = await synthesizeApi.query({ query: q });
      setAnswers((prev) => [
        ...prev,
        {
          question: pendingQuestion,
          answer: result.response,
          capture_count: result.capture_count,
        },
      ]);
    } catch {
      toast.error('Synthesis failed — please try again.');
      // Restore the question so the user can retry without re-typing
      setQuestion(pendingQuestion);
    } finally {
      setLoading(false);
      // Re-focus for next question
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  return (
    <div className="mt-[10px]">
      {/* Toggle button — shown when panel is closed */}
      {!open && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Sparkles size={11} strokeWidth={1.5} />}
          onClick={handleToggle}
          className="w-full justify-start text-text-body-secondary"
        >
          Ask follow-up
        </Button>
      )}

      {/* Expanded panel */}
      {open && (
        <div className="flex flex-col gap-[10px]">
          {/* Input row */}
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-[6px]"
          >
            <input
              ref={inputRef}
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this brief…"
              disabled={loading}
              className={[
                'flex-1 min-w-0 h-[28px]',
                'bg-bg-container border border-cloud-medium',
                'font-body text-[12.5px] font-light text-text-body',
                'px-[10px] outline-none rounded-none',
                'focus:border-slate-medium',
                'disabled:opacity-50',
                'transition-[border-color] duration-[120ms]',
                'placeholder:text-text-body-secondary',
              ].join(' ')}
            />
            <button
              type="submit"
              disabled={!question.trim() || loading}
              className={[
                'inline-flex items-center justify-center',
                'h-[28px] w-[28px] shrink-0',
                'bg-book-cloth border border-book-cloth',
                'text-ivory-light rounded-none',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'hover:bg-book-cloth-dark hover:border-book-cloth-dark',
                'transition-[background,border-color] duration-[120ms] cursor-pointer',
              ].join(' ')}
              aria-label="Submit question"
            >
              <Send size={11} strokeWidth={1.5} />
            </button>
          </form>

          {/* Loading shimmer */}
          {loading && (
            <div
              className="rounded-none p-[12px] border border-cloud-medium"
              style={{ background: 'var(--color-book-cloth-50, #fdf7f3)' }}
            >
              <div className="flex flex-col gap-[6px]">
                <div className="h-[10px] w-[60%] rounded bg-cloud-light animate-pulse" />
                <div className="h-[10px] w-[90%] rounded bg-cloud-light animate-pulse" />
                <div className="h-[10px] w-[75%] rounded bg-cloud-light animate-pulse" />
              </div>
            </div>
          )}

          {/* Answer cards — newest at bottom, accumulating */}
          {answers.map((item, i) => (
            <div
              key={i}
              className="flex flex-col gap-[6px] border border-cloud-medium p-[12px]"
              style={{ background: 'var(--color-book-cloth-50, #fdf7f3)' }}
            >
              {/* Question echo */}
              <div className="font-mono text-[10px] tracking-[0.06em] text-text-body-secondary uppercase leading-[1.4]">
                {item.question}
              </div>

              {/* Answer body */}
              <p className="m-0 text-[13px] font-light text-text-body leading-[1.6]">
                {item.answer}
              </p>

              {/* Source count footnote */}
              {item.capture_count > 0 && (
                <div className="font-mono text-[10px] text-text-body-secondary tracking-[0.04em]">
                  {item.capture_count} source{item.capture_count !== 1 ? 's' : ''} · {briefTitle}
                </div>
              )}
            </div>
          ))}

          {/* Collapse link — shown after at least one answer or when idle */}
          <button
            type="button"
            onClick={handleToggle}
            className={[
              'self-start font-mono text-[10.5px] tracking-[0.04em]',
              'text-text-body-secondary hover:text-text-body',
              'bg-transparent border-none p-0 cursor-pointer',
              'transition-colors duration-[120ms]',
            ].join(' ')}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
