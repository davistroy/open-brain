'use client';

interface TabItem {
  id: string;
  label: string;
  count?: number;
}

interface TypeFilterTabsProps {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
}

/**
 * Entity type filter tab bar.
 * Active tab: 2px terracotta (book-cloth) bottom underline, heading color text.
 * Inactive tab: body-secondary color, light weight.
 * Count badge per tab in mono 10.5px.
 *
 * 'use client' — interactive tab selection.
 */
export function TypeFilterTabs({ items, active, onChange }: TypeFilterTabsProps) {
  return (
    <div
      className="flex border-b border-cloud-light mb-[18px]"
      role="tablist"
    >
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className={[
              'inline-flex items-center gap-[8px]',
              'px-[18px] py-[10px]',
              'font-body text-[13px] tracking-[0.005em] cursor-pointer',
              'border-none bg-transparent',
              'border-b-2 -mb-px',
              'transition-colors duration-[120ms]',
              isActive
                ? 'border-book-cloth text-text-heading font-normal'
                : 'border-transparent text-text-body-secondary font-light hover:text-text-body',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="font-mono text-[10.5px] text-text-body-secondary font-normal">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
