import { type ReactNode } from 'react';

interface CardProps {
  /** Display-font header (15px/400). Optional. */
  header?: ReactNode;
  /** Muted subheading below header. Optional. */
  description?: ReactNode;
  /** Right-aligned action slot in header row. Optional. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Whether to pad the card body (default true). */
  padded?: boolean;
  className?: string;
}

/**
 * SCard port — container with bg-container, 1px cloud-light border, hard corners.
 * Server component (no interactivity).
 */
export function Card({
  header,
  description,
  actions,
  children,
  padded = true,
  className = '',
}: CardProps) {
  const hasHeader = header || actions;

  return (
    <section
      className={[
        'bg-bg-container border border-cloud-light rounded-none',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hasHeader && (
        <div className="flex items-start gap-4 px-[18px] py-[12px] border-b border-cloud-light">
          <div className="flex-1 min-w-0">
            {header && (
              <div className="font-display text-[15px] font-normal tracking-[-0.005em] text-text-heading">
                {header}
              </div>
            )}
            {description && (
              <div className="text-[12.5px] text-text-body-secondary mt-[3px] font-light tracking-[0.005em]">
                {description}
              </div>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-[6px] shrink-0">{actions}</div>
          )}
        </div>
      )}
      <div className={padded ? 'px-[18px] py-[16px]' : ''}>{children}</div>
    </section>
  );
}
