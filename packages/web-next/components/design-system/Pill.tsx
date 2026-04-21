import { type ReactNode } from 'react';

type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'ghost';
type PillSize = 'sm' | 'xs';

interface PillProps {
  children: ReactNode;
  tone?: PillTone;
  size?: PillSize;
  className?: string;
}

/**
 * Tone-specific Tailwind class triples.
 * status-* tokens are defined as CSS vars in globals.css and mapped in tailwind.config.ts.
 * accent uses book-cloth palette; neutral + ghost use ivory/cloud.
 */
const toneClasses: Record<PillTone, string> = {
  neutral:
    'bg-ivory-dark text-text-body border-cloud-light',
  accent:
    'bg-book-cloth-50 text-book-cloth-dark border-[var(--color-status-accent-border)]',
  success:
    'bg-status-success-bg text-status-success-fg border-status-success-border',
  warning:
    'bg-status-warning-bg text-status-warning-fg border-status-warning-border',
  error:
    'bg-status-error-bg text-status-error-fg border-status-error-border',
  ghost:
    'bg-transparent text-text-body-secondary border-cloud-light',
};

const sizeClasses: Record<PillSize, string> = {
  sm: 'text-[11.5px] px-[8px] py-[2px]',
  xs: 'text-[10.5px] px-[6px] py-[1px]',
};

/**
 * Status/label pill — hard corners, semantic color tokens, two sizes.
 * Server component.
 */
export function Pill({
  children,
  tone = 'neutral',
  size = 'sm',
  className = '',
}: PillProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-[4px]',
        'font-body font-normal tracking-[0.005em] whitespace-nowrap',
        'border rounded-none',
        toneClasses[tone],
        sizeClasses[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}
