import { type ReactNode } from 'react';

interface EyebrowProps {
  children: ReactNode;
  /** Remove bottom margin (default false — 10px mb applied). */
  noMargin?: boolean;
  className?: string;
}

/**
 * Small all-caps section label — JetBrains Mono 10.5px, 0.08em tracking.
 * Used above headings and in card section groupings.
 * Server component.
 */
export function Eyebrow({ children, noMargin = false, className = '' }: EyebrowProps) {
  return (
    <div
      className={[
        'font-mono text-[10.5px] font-normal uppercase tracking-[0.08em]',
        'text-text-body-secondary',
        noMargin ? '' : 'mb-[10px]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
