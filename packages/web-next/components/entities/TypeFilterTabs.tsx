'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

interface TabItem {
  id: string;
  label: string;
  count?: number;
}

interface TypeFilterTabsProps {
  items: TabItem[];
  /** The currently active type from searchParams (passed from RSC parent) */
  activeType: string;
}

/**
 * Entity type filter tab bar.
 * Active tab: 2px terracotta (book-cloth) bottom underline, heading color text.
 * Inactive tab: body-secondary color, light weight.
 * Count badge per tab in mono 10.5px.
 *
 * 'use client' — reads useSearchParams to preserve non-type search params
 * in the generated Link hrefs; navigates via <Link> (no JS state).
 */
export function TypeFilterTabs({ items, activeType }: TypeFilterTabsProps) {
  const searchParams = useSearchParams();

  function buildHref(typeId: string): string {
    const params = new URLSearchParams(searchParams.toString());
    if (typeId === 'all') {
      params.delete('type');
    } else {
      params.set('type', typeId);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '?';
  }

  return (
    <div
      className="flex border-b border-cloud-light mb-[18px]"
      role="tablist"
    >
      {items.map((item) => {
        const isActive = item.id === activeType;
        return (
          <Link
            key={item.id}
            href={buildHref(item.id)}
            role="tab"
            aria-selected={isActive}
            className={[
              'inline-flex items-center gap-[8px]',
              'px-[18px] py-[10px]',
              'font-body text-[13px] tracking-[0.005em]',
              'border-none bg-transparent no-underline',
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
          </Link>
        );
      })}
    </div>
  );
}
