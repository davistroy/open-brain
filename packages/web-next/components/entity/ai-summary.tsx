import { Sparkles } from 'lucide-react';
import { Button } from '@/components/design-system';

interface AISummaryProps {
  summary: string;
  updatedAt: string;
}

/**
 * Terracotta callout block — AI-generated summary with update timestamp.
 * Matches 06-entity-detail.html:149-166.
 * Server component.
 */
export function AISummary({ summary, updatedAt }: AISummaryProps) {
  return (
    <div
      className="mb-5"
      style={{
        background: 'var(--color-book-cloth-50)',
        borderLeft: '3px solid var(--color-book-cloth)',
        padding: '18px 22px',
      }}
    >
      {/* Header row: icon + timestamp */}
      <div className="flex items-center gap-2 mb-[10px]">
        <Sparkles
          size={12}
          strokeWidth={1.5}
          style={{ color: 'var(--color-book-cloth-dark)' }}
        />
        <span
          style={{
            fontFamily: 'var(--font-family-monospace)',
            fontSize: 10.5,
            color: 'var(--color-book-cloth-dark)',
            letterSpacing: '0.08em',
          }}
        >
          AI SUMMARY · UPDATED {updatedAt.toUpperCase()}
        </span>
      </div>

      {/* Summary body */}
      <p
        className="text-text-heading"
        style={{
          fontFamily: 'var(--font-family-display)',
          fontSize: 19,
          fontWeight: 300,
          lineHeight: 1.5,
          margin: 0,
          letterSpacing: '-0.005em',
        }}
      >
        {summary}
      </p>

      {/* Actions */}
      <div className="flex gap-[10px] mt-[14px]">
        <Button variant="secondary" size="sm">
          Why this summary?
        </Button>
        <Button variant="ghost" size="sm">
          Refine
        </Button>
      </div>
    </div>
  );
}
