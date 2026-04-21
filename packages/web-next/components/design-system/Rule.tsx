import { type ReactNode } from 'react';

interface RuleProps {
  /** Optional label centered on the divider line. */
  label?: ReactNode;
  /** Vertical margin (default '16px 0' equivalent: my-4). Override with className. */
  className?: string;
}

/**
 * 1px horizontal divider using cloud-light color.
 * Optionally renders a centered label (eyebrow-style) over the line.
 * Server component.
 */
export function Rule({ label, className = '' }: RuleProps) {
  if (label) {
    return (
      <div
        className={[
          'flex items-center gap-3 my-4',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="flex-1 h-px bg-cloud-light" />
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-body-secondary shrink-0">
          {label}
        </span>
        <div className="flex-1 h-px bg-cloud-light" />
      </div>
    );
  }

  return (
    <div
      className={[
        'h-px bg-cloud-light border-0 my-4',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}
