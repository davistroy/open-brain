import { type ReactNode } from 'react';

type ContainerSize = 'sm' | 'md' | 'lg' | 'full';

interface ContainerProps {
  /** h3 heading inside container header (Space Grotesk 18px/400). */
  header?: ReactNode;
  /** Muted description line below header. */
  description?: ReactNode;
  /** Right-aligned action slot in header row. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Max-width sizing preset. */
  size?: ContainerSize;
  /** Whether to pad the body (default true). */
  padding?: boolean;
  className?: string;
}

const sizeClasses: Record<ContainerSize, string> = {
  sm:   'max-w-[640px]',
  md:   'max-w-[960px]',
  lg:   'max-w-[1280px]',
  full: 'w-full',
};

/**
 * Dashboard container — h3 header, 2px radius (rounded-container), shadow-container.
 * Distinct from Card: used for dashboard sections with an h3-level header.
 * Server component.
 */
export function Container({
  header,
  description,
  actions,
  children,
  size = 'full',
  padding = true,
  className = '',
}: ContainerProps) {
  const hasHeader = header || actions;

  return (
    <div
      className={[
        'bg-bg-container border border-cloud-light rounded-container shadow-container',
        sizeClasses[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hasHeader && (
        <div className="flex items-start gap-4 px-[18px] py-[12px] border-b border-cloud-light">
          <div className="flex-1 min-w-0">
            {header && (
              <h3 className="font-display text-[18px] font-normal tracking-[-0.01em] text-text-heading m-0">
                {header}
              </h3>
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
      <div className={padding ? 'px-[18px] py-[16px]' : ''}>{children}</div>
    </div>
  );
}
