'use client';

/**
 * SettingsSidebar — Cloudscape screen 11 left navigation panel.
 *
 * 8 sections with URL-driven active state. Active section gets:
 *   - 3px book-cloth left border (border-l-[3px] border-l-book-cloth)
 *   - book-cloth-50 wash background (bg-book-cloth-50 / --color-book-cloth-50)
 *
 * Sections are Link elements that push `?section=<key>` to the URL.
 * Using next/link ensures RSC re-renders SettingsPage with the new section.
 */

import Link from 'next/link';
import {
  User,
  Palette,
  Rss,
  Bell,
  BookOpen,
  ShieldCheck,
  LayoutGrid,
  CreditCard,
  Key,
  TriangleAlert,
  Cpu,
  Mail,
  Activity,
  Tag,
  Mic,
  Library,
  type LucideIcon,
} from 'lucide-react';
import type { SettingsSection } from '@/app/(shell)/settings/page';

interface SidebarItem {
  key: SettingsSection;
  label: string;
  icon: LucideIcon;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { key: 'profile',           label: 'Profile',           icon: User },
  { key: 'appearance',        label: 'Appearance',        icon: Palette },
  { key: 'ai-routing',        label: 'AI routing',        icon: Cpu },
  { key: 'triggers',          label: 'Triggers',          icon: Bell },
  { key: 'sources',           label: 'Sources',           icon: Rss },
  { key: 'email-config',      label: 'Email config',      icon: Mail },
  { key: 'email-allowlist',   label: 'Email allowlist',   icon: ShieldCheck },
  { key: 'voice',             label: 'Voice',             icon: Mic },
  { key: 'wiki',              label: 'Wiki',              icon: Library },
  { key: 'service-health',    label: 'Service health',    icon: Activity },
  { key: 'version-uptime',    label: 'Version & Uptime',  icon: Tag },
  { key: 'brief-preferences', label: 'Brief preferences', icon: BookOpen },
  { key: 'privacy',           label: 'Privacy & data',    icon: ShieldCheck },
  { key: 'workspaces',        label: 'Workspaces',        icon: LayoutGrid },
  { key: 'billing',           label: 'Billing',           icon: CreditCard },
  { key: 'api-export',        label: 'API & export',      icon: Key },
  { key: 'danger',            label: 'Danger zone',       icon: TriangleAlert },
];

interface SettingsSidebarProps {
  activeSection: SettingsSection;
}

export function SettingsSidebar({ activeSection }: SettingsSidebarProps) {
  return (
    <nav
      className="border border-cloud-light overflow-hidden"
      aria-label="Settings navigation"
    >
      {SIDEBAR_ITEMS.map((item, idx) => {
        const isActive = item.key === activeSection;
        // Danger zone gets a subtle top divider to visually separate it
        const hasDivider = item.key === 'danger';

        return (
          <Link
            key={item.key}
            href={`/settings?section=${item.key}`}
            className={[
              // Layout
              'flex items-center gap-3 px-4 py-[10px]',
              // Typography
              'text-[13px] font-medium leading-[18px] no-underline',
              // Divider (only for danger zone)
              hasDivider ? 'border-t border-cloud-light' : '',
              // Bottom border between items (except last)
              idx < SIDEBAR_ITEMS.length - 1 && !hasDivider ? 'border-b border-cloud-light' : '',
              // Active state: book-cloth left accent + wash background
              isActive
                ? 'border-l-[3px] border-l-book-cloth bg-[var(--color-book-cloth-50)] text-[var(--color-slate-dark)] pl-[13px]'
                : 'border-l-[3px] border-l-transparent text-text-body hover:bg-[var(--color-ivory-medium)] hover:text-text-heading pl-[13px]',
              // Transition
              'transition-colors duration-100',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-current={isActive ? 'page' : undefined}
          >
            <item.icon
              size={14}
              strokeWidth={1.5}
              className={
                item.key === 'danger'
                  ? 'text-[var(--color-faded-red)] shrink-0'
                  : isActive
                  ? 'text-[var(--color-book-cloth)] shrink-0'
                  : 'text-text-small shrink-0'
              }
            />
            <span
              className={
                item.key === 'danger'
                  ? 'text-[var(--color-faded-red)]'
                  : undefined
              }
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
