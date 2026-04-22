import { Sparkles } from 'lucide-react';
import type { Capture } from '@/lib/types';

interface AiSummaryProps {
  capture: Capture;
}

/**
 * Extract summary text from a capture.
 * Prefers source_metadata.summary if present, otherwise uses the first paragraph
 * of content (up to 500 chars).
 */
function extractSummary(capture: Capture): string | null {
  const meta = (capture as unknown as { source_metadata?: Record<string, unknown> })
    .source_metadata;
  if (typeof meta?.summary === 'string' && meta.summary.trim().length > 0) {
    return meta.summary.trim();
  }

  const content = capture.content ?? '';
  if (!content.trim()) return null;

  // Use first paragraph (split on blank line)
  const firstParagraph = content.split(/\n\s*\n/)[0]?.trim() ?? content.trim();
  return firstParagraph.length > 500 ? firstParagraph.slice(0, 497) + '…' : firstParagraph;
}

/**
 * AI summary callout block — Cloudscape screen 10.
 * Book-cloth-50 background, 3px left book-cloth border, sparkle icon + SUMMARY eyebrow,
 * display-font summary text (17px, weight 300).
 * Server component.
 */
export function AiSummary({ capture }: AiSummaryProps) {
  const summary = extractSummary(capture);

  // Don't render if no meaningful summary content
  if (!summary) return null;

  return (
    <div
      style={{
        background: 'var(--color-book-cloth-50)',
        borderLeft: '3px solid var(--color-book-cloth)',
        padding: '18px 22px',
      }}
    >
      {/* Header: sparkle icon + SUMMARY eyebrow */}
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
          SUMMARY
        </span>
      </div>

      {/* Summary body — display-font, 17px, weight 300 */}
      <p
        className="text-text-heading"
        style={{
          fontFamily: 'var(--font-family-display)',
          fontSize: 17,
          fontWeight: 300,
          lineHeight: 1.6,
          margin: 0,
          letterSpacing: '-0.005em',
        }}
      >
        {summary}
      </p>
    </div>
  );
}
