import type { BriefDetail } from '@/lib/types';

interface BriefReaderProps {
  brief: BriefDetail;
}

/**
 * Main reading column for the brief reader page.
 * Renders:
 *   - Eyebrow (DAILY BRIEF · TUESDAY, APRIL 21 · 07:00)
 *   - h1 headline (display 42px/300)
 *   - Meta subtitle row with dot separators
 *   - Article body via dangerouslySetInnerHTML + .reader prose class
 *
 * HTML body comes from trusted mock data (pre-rendered, no user input).
 * Server component.
 */
export function BriefReader({ brief }: BriefReaderProps) {
  // Split meta into segments for dot-separated display.
  // Guard: meta may be empty string if the API returned no subtitle and fallback failed.
  const metaSegments = (brief.meta ?? '').split(' · ').filter(Boolean);

  return (
    <article className="min-w-0">
      {/* Eyebrow — mono kind + date + time */}
      <div
        className="font-mono text-[10.5px] tracking-[0.1em] mb-[10px]"
        style={{ color: 'var(--color-book-cloth-dark)' }}
      >
        {brief.eyebrow}
      </div>

      {/* Headline */}
      <h1
        className="m-0 mb-[8px] font-display font-light leading-[1.1] text-text-heading"
        style={{ fontSize: 42, letterSpacing: '-0.025em' }}
      >
        {brief.headline}
      </h1>

      {/* Meta row */}
      <div
        className="flex flex-wrap gap-[16px] items-center text-[14px] font-light text-text-body-secondary pb-[20px] mb-[24px] border-b border-cloud-medium"
      >
        {metaSegments.map((seg, i) => (
          <span key={i} className="flex items-center gap-[16px]">
            {i > 0 && (
              <span className="text-cloud-medium" aria-hidden="true">
                ·
              </span>
            )}
            {seg}
          </span>
        ))}
      </div>

      {/* Article body — .reader prose class defined in globals.css */}
      <div
        className="reader"
        dangerouslySetInnerHTML={{ __html: brief.body_html }}
      />
    </article>
  );
}
