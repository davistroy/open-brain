import { type ReactNode } from 'react';

interface PageHeaderProps {
  /**
   * Array of breadcrumb strings. Last item renders in heading color;
   * earlier items render in body-secondary. Separated by `/`.
   */
  breadcrumb?: string[];
  /** Display-font title (30px/400). Optional — omit for breadcrumb-only headers. */
  title?: string;
  /** Light subtitle below title (13.5px/300). */
  subtitle?: string;
  /** Right-aligned slot — typically action Buttons. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Shared page header used on every shell page.
 * Breadcrumb + title + subtitle + right-side actions slot.
 * Server component.
 */
export function PageHeader({
  breadcrumb = [],
  title,
  subtitle,
  actions,
  className = '',
}: PageHeaderProps) {
  if (!breadcrumb.length && !title) return null;

  return (
    <div className={['mb-[18px]', className].filter(Boolean).join(' ')}>
      {breadcrumb.length > 0 && (
        <div className="flex items-center gap-[6px] mb-[10px] font-mono text-[10.5px] tracking-[0.04em] uppercase text-text-body-secondary">
          {breadcrumb.map((crumb, i) => (
            <span key={i} className="flex items-center gap-[6px]">
              {i > 0 && (
                <span className="opacity-40">/</span>
              )}
              <span
                className={
                  i === breadcrumb.length - 1
                    ? 'text-text-heading'
                    : ''
                }
              >
                {crumb}
              </span>
            </span>
          ))}
        </div>
      )}

      {title && (
        <div className="flex items-end justify-between gap-6 flex-wrap">
          <div>
            <h1 className="m-0 font-display text-[30px] font-normal tracking-[-0.02em] text-text-heading leading-[1.1]">
              {title}
            </h1>
            {subtitle && (
              <div className="text-[13.5px] text-text-body-secondary mt-[6px] font-light tracking-[0.005em] max-w-[640px]">
                {subtitle}
              </div>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-[8px] shrink-0">{actions}</div>
          )}
        </div>
      )}
    </div>
  );
}
