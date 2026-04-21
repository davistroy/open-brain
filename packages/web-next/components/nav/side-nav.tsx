'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Search,
  Clock,
  Upload,
  Mic,
  Mail,
  Users,
  BookOpenText,
  FileText,
  Lightbulb,
  Gavel,
  DollarSign,
  LineChart,
  Monitor,
  Settings,
  ChevronsUpDown,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  id: string;
  href: string;
  icon: LucideIcon;
  label: string;
  count?: number;
  dot?: 'success' | 'accent';
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    items: [
      { id: 'dashboard',  href: '/dashboard',  icon: LayoutDashboard, label: 'Dashboard' },
      { id: 'search',     href: '/search',     icon: Search,          label: 'Search' },
      { id: 'timeline',   href: '/timeline',   icon: Clock,           label: 'Timeline', count: 842 },
    ],
  },
  {
    title: 'Capture',
    items: [
      { id: 'ingest', href: '/ingest', icon: Upload, label: 'Ingest' },
      { id: 'voice',  href: '/voice',  icon: Mic,    label: 'Voice capture' },
      { id: 'email',  href: '/email',  icon: Mail,   label: 'Email bridge', count: 12 },
    ],
  },
  {
    title: 'Knowledge',
    items: [
      { id: 'entities',     href: '/entities',     icon: Users,       label: 'Entities' },
      { id: 'wiki',         href: '/wiki',         icon: BookOpenText, label: 'Wiki' },
      { id: 'briefs',       href: '/briefs',       icon: FileText,    label: 'Briefs', count: 3 },
      { id: 'intelligence', href: '/intelligence', icon: Lightbulb,   label: 'Intelligence' },
    ],
  },
  {
    title: 'Governance',
    items: [
      { id: 'board',       href: '/board',       icon: Gavel,      label: 'Board' },
      { id: 'financial',   href: '/financial',   icon: DollarSign, label: 'Financial' },
      { id: 'investments', href: '/investments', icon: LineChart,  label: 'Investments' },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'system',   href: '/system',   icon: Monitor,  label: 'System status', dot: 'success' },
      { id: 'settings', href: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
];

/**
 * SideNav — 280px left sidebar. Client component: uses usePathname() for active state.
 * Active item: bg-bg-item-selected + 2px left border-book-cloth + font-weight 500.
 */
export function SideNav() {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <nav
      className={[
        'w-[280px] shrink-0',
        'bg-bg-container border-r border-border-divider',
        'py-[20px] overflow-y-auto',
        'sticky top-[56px] h-[calc(100vh-56px)]',
      ].join(' ')}
      aria-label="Main navigation"
    >
      {/* Workspace selector */}
      <div className="px-[20px] pb-[16px] border-b border-border-divider-secondary mb-[12px]">
        <div className="font-mono text-[10px] font-normal tracking-[0.10em] text-text-small uppercase">
          Workspace
        </div>
        <div className="flex items-center gap-[8px] mt-[6px] font-normal text-[14px] text-text-heading">
          {/* Workspace square */}
          <div
            className={[
              'w-[20px] h-[20px] rounded-none shrink-0',
              'bg-slate-medium text-ivory-light',
              'flex items-center justify-center text-[11px]',
            ].join(' ')}
          >
            P
          </div>
          <span className="flex-1 truncate">Personal — Troy</span>
          <ChevronsUpDown size={14} strokeWidth={1.5} className="text-text-small shrink-0" />
        </div>
      </div>

      {/* Navigation sections */}
      {SECTIONS.map((section, si) => (
        <div key={si} className="mb-[8px]">
          {section.title && (
            <div
              className={[
                'font-mono text-[10px] font-normal tracking-[0.10em] text-text-small',
                'uppercase px-[20px] pt-[10px] pb-[4px]',
              ].join(' ')}
            >
              {section.title}
            </div>
          )}
          {section.items.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                href={item.href}
                className={[
                  // Layout
                  'relative flex items-center gap-[12px]',
                  'w-[calc(100%-12px)] mx-[6px]',
                  'px-[14px] py-[7px]',
                  'rounded-none',
                  // Typography
                  'text-[13.5px] tracking-[0.005em]',
                  'no-underline transition-colors duration-moderate',
                  // Active / inactive
                  active
                    ? 'bg-bg-item-selected text-text-heading font-medium tracking-[0]'
                    : 'text-text-body-secondary font-light hover:bg-ivory-dark hover:text-text-heading',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-current={active ? 'page' : undefined}
              >
                {/* Active left border */}
                {active && (
                  <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-book-cloth" />
                )}

                <Icon size={15} strokeWidth={1.5} className="shrink-0" aria-hidden="true" />
                <span className="flex-1">{item.label}</span>

                {/* Count badge */}
                {item.count != null && (
                  <span className="font-mono text-[10.5px] font-normal text-text-small tracking-[0.02em]">
                    {item.count}
                  </span>
                )}

                {/* Status dot (System status) */}
                {item.dot && (
                  <span
                    className="w-[6px] h-[6px] rounded-full shrink-0"
                    style={{
                      background:
                        item.dot === 'success'
                          ? 'var(--color-success)'
                          : 'var(--color-book-cloth)',
                    }}
                    aria-label={item.dot === 'success' ? 'Healthy' : undefined}
                  />
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
