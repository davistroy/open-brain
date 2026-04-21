import { type ReactNode } from 'react';

interface MetaItem {
  /** All-caps monospace key (rendered with `: ` separator). */
  label: string;
  /** Value rendered in heading color at normal weight. */
  value: ReactNode;
}

interface MetaLineProps {
  /** Array of label/value pairs rendered inline. */
  items?: MetaItem[];
  /** Divider character between items (default ` · `). */
  separator?: string;
  /** Single label+value shorthand. Use `items` for multiple pairs. */
  label?: string;
  value?: ReactNode;
  className?: string;
}

/**
 * Horizontal line of metadata items — monospace key:value pairs.
 * Used for capture metadata (date, type, source, etc.).
 * Server component.
 */
export function MetaLine({
  items,
  separator = ' · ',
  label,
  value,
  className = '',
}: MetaLineProps) {
  // Single-pair shorthand
  const resolved: MetaItem[] =
    items ?? (label != null ? [{ label, value }] : []);

  return (
    <span
      className={[
        'font-mono text-[10.5px] tracking-[0.04em] uppercase text-text-body-secondary',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {resolved.map((item, i) => (
        <span key={i}>
          {i > 0 && <span>{separator}</span>}
          {item.label}:{' '}
          <span className="text-text-heading font-normal normal-case">{item.value}</span>
        </span>
      ))}
    </span>
  );
}
