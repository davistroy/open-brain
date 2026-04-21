type DotStatus = 'success' | 'warning' | 'error' | 'accent' | 'neutral' | 'processing';

interface StatusDotProps {
  status: DotStatus;
  /** Optional text label rendered after the dot. */
  label?: string;
  className?: string;
}

/**
 * Color map: status → inline background color via CSS var.
 * Uses the same semantic tokens as Pill for visual consistency.
 */
const statusColor: Record<DotStatus, string> = {
  success:    'var(--color-success)',
  warning:    'var(--color-status-warning-fg)',
  error:      'var(--color-status-error-fg)',
  accent:     'var(--color-book-cloth)',
  neutral:    'var(--color-cloud-dark)',
  processing: 'var(--color-book-cloth)',
};

/**
 * 6px square status indicator dot, optionally with a label.
 * Variants mirror Pill tones. Hard corners (square not circle).
 * Server component.
 */
export function StatusDot({ status, label, className = '' }: StatusDotProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-[5px]',
        'font-mono text-[10.5px] tracking-[0.04em] text-text-body-secondary',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        className="shrink-0 inline-block w-[6px] h-[6px]"
        style={{ background: statusColor[status] }}
      />
      {label && <span>{label}</span>}
    </span>
  );
}
