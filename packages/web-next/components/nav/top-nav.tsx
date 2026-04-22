import { Sparkles, Bell, CircleHelp, ChevronDown, Search } from 'lucide-react';
import { ThemeToggle } from '@/components/design-system/ThemeToggle';

// UtilItem — icon button in top-right utility cluster
function UtilItem({
  icon: Icon,
  label,
  badge,
  accent,
}: {
  icon: React.ElementType;
  label?: string;
  badge?: number;
  accent?: boolean;
}) {
  return (
    <div
      className={[
        'relative inline-flex items-center gap-[6px] cursor-pointer',
        'text-[13px] tracking-[0.005em] transition-colors duration-moderate',
        label ? 'py-[5px] px-[12px]' : 'p-[7px]',
        accent
          ? 'text-book-cloth hover:bg-[rgba(204,120,92,0.24)] bg-[rgba(204,120,92,0.16)] font-normal'
          : 'text-cloud-light hover:bg-[rgba(255,255,255,0.06)] font-light',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon size={16} strokeWidth={1.5} />
      {label && <span>{label}</span>}
      {badge != null && (
        <span
          className={[
            'absolute top-[2px] right-[2px]',
            'min-w-[14px] h-[14px] px-[3px]',
            'bg-faded-red text-white',
            'text-[10px] font-medium',
            'rounded-none flex items-center justify-center',
            'font-mono border-[1.5px] border-bg-home-header',
          ].join(' ')}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

/**
 * TopNav — 56px sticky header. Server component (no interactivity in M1).
 * Background: --color-bg-home-header (warm dark slate).
 */
export function TopNav({ user = 'troy@openbrain.io' }: { user?: string }) {
  return (
    <header
      className={[
        'h-[56px] flex items-center gap-[24px] px-[24px]',
        'bg-bg-home-header text-ivory-medium',
        'border-b border-[rgba(255,255,255,0.06)]',
        'sticky top-0 z-20',
      ].join(' ')}
    >
      {/* Brand */}
      <div
        className={[
          'flex items-center gap-[10px] shrink-0 whitespace-nowrap',
          'font-display text-[17px] tracking-[-0.005em] text-ivory-light',
        ].join(' ')}
      >
        {/* Brain SVG — inline, stroke book-cloth, strokeWidth 0.9 */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-book-cloth)"
          strokeWidth="0.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ vectorEffect: 'non-scaling-stroke' } as React.CSSProperties}
          aria-hidden="true"
        >
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
          <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
        </svg>
        <span>
          Open <span className="font-light">Brain</span>
        </span>
      </div>

      {/* Search bar */}
      <div className="flex-1 max-w-[560px] relative flex items-center">
        <Search
          size={15}
          strokeWidth={1.5}
          className="absolute left-[14px] text-cloud-medium pointer-events-none"
          aria-hidden="true"
        />
        <input
          type="search"
          placeholder="Search everything — captures, entities, briefs…"
          className={[
            'w-full h-[32px] rounded-none',
            'bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.08)]',
            'pl-[36px] pr-[60px]',
            'text-ivory-light font-light text-[13px] tracking-[0.005em]',
            'placeholder:text-cloud-medium',
            'outline-none transition-[border-color,background] duration-moderate',
            'focus:border-book-cloth focus:bg-[rgba(255,255,255,0.09)]',
          ].join(' ')}
        />
        <span
          className={[
            'absolute right-[10px] pointer-events-none',
            'font-mono text-[10.5px] text-cloud-medium',
            'border border-[rgba(255,255,255,0.12)] rounded-none px-[6px] py-[1px]',
          ].join(' ')}
        >
          ⌘K
        </span>
      </div>

      {/* Utility cluster */}
      <div className="flex items-center gap-[2px] text-[13px] text-cloud-light">
        <UtilItem icon={Sparkles} label="Ask AI" accent />
        <UtilItem icon={Bell} badge={3} />
        <ThemeToggle />
        <UtilItem icon={CircleHelp} />

        {/* Divider */}
        <div className="w-[1px] h-[24px] bg-[rgba(255,255,255,0.08)] mx-[10px]" />

        {/* User */}
        <div
          className={[
            'flex items-center gap-[10px] cursor-pointer',
            'py-[4px] pl-[4px] pr-[10px] rounded-none',
            'hover:bg-[rgba(255,255,255,0.06)] transition-colors duration-moderate',
          ].join(' ')}
        >
          {/* Avatar square */}
          <div
            className={[
              'w-[24px] h-[24px] rounded-none shrink-0',
              'bg-book-cloth text-ivory-light',
              'flex items-center justify-center',
              'text-[11px] font-normal font-body tracking-[0.02em]',
            ].join(' ')}
          >
            TD
          </div>
          <span className="text-[13px] font-light text-ivory-medium">{user}</span>
          <ChevronDown size={14} strokeWidth={1.5} className="text-cloud-medium" />
        </div>
      </div>
    </header>
  );
}
