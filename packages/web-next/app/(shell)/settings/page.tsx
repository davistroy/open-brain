export const dynamic = 'force-dynamic';

/**
 * Settings page — Screen 11.
 *
 * RSC with URL-driven section routing via `?section=<key>` searchParam.
 * Layout: 2-column grid — 220px SettingsSidebar + flex content area.
 * Default section: 'sources' (first live section).
 *
 * Sections and status:
 *   Profile           → EmptySettingsSection (placeholder)
 *   Sources           → live (configApi.integrations + ingest toggle settings)
 *   Brief preferences → EmptySettingsSection
 *   Privacy & data    → EmptySettingsSection
 *   Workspaces        → EmptySettingsSection
 *   Billing           → EmptySettingsSection
 *   API & export      → EmptySettingsSection
 *   Danger zone       → DangerZoneSection (live — two-step reset flow)
 */

import { PageHeader } from '@/components/design-system';
import { SettingsSidebar } from '@/components/settings/SettingsSidebar';
import { SettingsSectionContent } from '@/components/settings/SettingsSectionContent';

// Section keys must match SettingsSidebar items
export type SettingsSection =
  | 'profile'
  | 'appearance'
  | 'sources'
  | 'triggers'
  | 'ai-routing'
  | 'email-config'
  | 'email-allowlist'
  | 'voice'
  | 'wiki'
  | 'service-health'
  | 'version-uptime'
  | 'brief-preferences'
  | 'privacy'
  | 'workspaces'
  | 'billing'
  | 'api-export'
  | 'danger';

const DEFAULT_SECTION: SettingsSection = 'sources';

/** Map a raw searchParam to a valid section key (falls back to default). */
function resolveSection(raw: string | undefined): SettingsSection {
  const valid: SettingsSection[] = [
    'profile',
    'appearance',
    'sources',
    'triggers',
    'ai-routing',
    'email-config',
    'email-allowlist',
    'voice',
    'wiki',
    'service-health',
    'version-uptime',
    'brief-preferences',
    'privacy',
    'workspaces',
    'billing',
    'api-export',
    'danger',
  ];
  return (valid.includes(raw as SettingsSection) ? raw : DEFAULT_SECTION) as SettingsSection;
}

interface SettingsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const params = await searchParams;
  const rawSection = Array.isArray(params.section) ? params.section[0] : params.section;
  const activeSection = resolveSection(rawSection);

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Settings']}
        title="Settings"
        subtitle="Configure your brain — sources, preferences, and integrations"
      />

      {/* 2-column layout: 220px sidebar + fill content */}
      <div
        className="mt-2"
        style={{
          display: 'grid',
          gridTemplateColumns: '220px minmax(0, 1fr)',
          gap: '0',
          alignItems: 'start',
        }}
      >
        {/* Left sidebar — sticky so it stays in view on scroll */}
        <div className="sticky top-6">
          <SettingsSidebar activeSection={activeSection} />
        </div>

        {/* Right content area */}
        <div className="pl-8 min-h-[480px]">
          <SettingsSectionContent section={activeSection} />
        </div>
      </div>
    </>
  );
}
