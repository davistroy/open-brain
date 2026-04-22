export const dynamic = 'force-dynamic';

/**
 * Settings page — Cloudscape screen 11.
 *
 * RSC with URL-driven section routing via `?section=<key>` searchParam.
 * Layout: 2-column grid — 220px SettingsSidebar + flex content area.
 * Default section: 'sources' (first live section).
 *
 * Sections and status:
 *   Profile           → EmptySettingsSection (M3 placeholder)
 *   Sources           → live (configApi.integrations + ingest toggle settings)
 *   Brief preferences → EmptySettingsSection
 *   Privacy & data    → EmptySettingsSection
 *   Workspaces        → EmptySettingsSection
 *   Billing           → EmptySettingsSection
 *   API & export      → EmptySettingsSection
 *   Danger zone       → DangerZoneSection (live — two-step reset flow)
 */

import { SettingsSidebar } from '@/components/settings/SettingsSidebar';
import { PageHeader } from '@/components/design-system';

// Section keys must match SettingsSidebar items
export type SettingsSection =
  | 'profile'
  | 'sources'
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
    'sources',
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

// ---------------------------------------------------------------------------
// Section content router — inline for M3 skeleton (live sections added in 3.2/3.3)
// ---------------------------------------------------------------------------

import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';

/** Copy map for empty-state sections — Cloudscape editorial voice */
const EMPTY_SECTION_COPY: Record<string, { title: string; description: string }> = {
  profile: {
    title: 'Profile',
    description:
      'Personalize your Open Brain experience — name, role, and display preferences. This section is under construction — check back soon.',
  },
  'brief-preferences': {
    title: 'Brief preferences',
    description:
      'Control when your daily and weekly briefs are generated, which brain views to include, and how summaries are structured. This section is under construction — check back soon.',
  },
  privacy: {
    title: 'Privacy & data',
    description:
      'Manage data retention, export your knowledge base, and control what Open Brain stores. This section is under construction — check back soon.',
  },
  workspaces: {
    title: 'Workspaces',
    description:
      'Organize your brain into separate workspaces for different contexts — personal, professional, and project-specific. This section is under construction — check back soon.',
  },
  billing: {
    title: 'Billing',
    description:
      'Track your monthly AI spend, review costs by provider, and manage usage limits. This section is under construction — check back soon.',
  },
  'api-export': {
    title: 'API & export',
    description:
      'Access your Open Brain API key, review MCP tool usage, and export your knowledge base in machine-readable formats. This section is under construction — check back soon.',
  },
};

function EmptySettingsSection({ section }: { section: string }) {
  const copy = EMPTY_SECTION_COPY[section] ?? {
    title: 'Coming soon',
    description: 'This section is under construction — check back soon.',
  };

  return (
    <div className="bg-bg-container border border-cloud-light px-8 py-10">
      <EmptyState
        icon={Construction}
        title={copy.title}
        description={copy.description}
      />
    </div>
  );
}

function SettingsSectionContent({ section }: { section: SettingsSection }) {
  // Live sections (3.2 Sources, 3.3 Danger zone) will replace these stubs.
  // For now all sections render either a placeholder or a future component.
  switch (section) {
    case 'sources':
      // Sources section placeholder — will be replaced by SourcesSection in 3.2
      return (
        <div className="bg-bg-container border border-cloud-light px-8 py-10">
          <EmptyState
            icon={Construction}
            title="Sources"
            description="Configure your connected data sources — Slack, voice, email, and file ingestion. This section is under construction — check back soon."
          />
        </div>
      );

    case 'danger':
      // Danger zone placeholder — will be replaced by DangerZoneSection in 3.3
      return (
        <div className="bg-bg-container border border-cloud-light px-8 py-10">
          <EmptyState
            icon={Construction}
            title="Danger zone"
            description="Permanently reset all data and start fresh. Two-step confirmation required. This section is under construction — check back soon."
          />
        </div>
      );

    default:
      return <EmptySettingsSection section={section} />;
  }
}
