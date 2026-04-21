import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  /** Lucide icon component (e.g. `import { Inbox } from 'lucide-react'`). */
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Optional action node — typically a Button. */
  action?: ReactNode;
  className?: string;
}

/**
 * Centered empty state: 40x40 icon box (1px border), display title,
 * muted description, optional action.
 * Server component.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={[
        'flex flex-col items-center px-8 py-12 text-center',
        'text-text-body-secondary',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Icon box */}
      <div className="w-10 h-10 flex items-center justify-center border border-cloud-light mb-[14px] shrink-0">
        {Icon && (
          <Icon
            className="text-cloud-dark"
            size={18}
            strokeWidth={1.3}
          />
        )}
      </div>

      {/* Title */}
      <div className="font-display text-[18px] font-normal tracking-[-0.01em] text-text-heading">
        {title}
      </div>

      {/* Description */}
      {description && (
        <div className="text-[13px] mt-[6px] max-w-[400px] leading-[1.5] font-light">
          {description}
        </div>
      )}

      {/* Action */}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
