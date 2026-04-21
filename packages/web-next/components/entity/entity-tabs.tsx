/**
 * Section tabs for the entity detail page.
 * Static in M1 — always shows Summary as active.
 * Matches 06-entity-detail.html:128-145.
 * Server component.
 */

interface TabItem {
  id: string;
  label: string;
  count?: number;
}

interface EntityTabsProps {
  items?: TabItem[];
  activeId?: string;
}

const DEFAULT_TABS: TabItem[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'captures', label: 'Captures', count: 14 },
  { id: 'relationships', label: 'Relationships', count: 11 },
  { id: 'commitments', label: 'Commitments', count: 3 },
];

export function EntityTabs({ items = DEFAULT_TABS, activeId = 'summary' }: EntityTabsProps) {
  return (
    <div
      className="flex border-b border-cloud-medium mb-5"
      role="tablist"
      aria-label="Entity sections"
    >
      {items.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={[
              'inline-flex items-center gap-2 px-[18px] py-[10px] -mb-px',
              'bg-transparent border-none cursor-pointer',
              'font-body text-[13px] transition-colors duration-[120ms]',
              isActive
                ? 'border-b-2 border-book-cloth text-text-heading font-normal'
                : 'border-b-2 border-transparent text-text-body-secondary font-light hover:text-text-heading',
            ].join(' ')}
            style={{ outline: 'none' }}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className="text-text-body-secondary"
                style={{ fontFamily: 'var(--font-family-monospace)', fontSize: 10.5 }}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
