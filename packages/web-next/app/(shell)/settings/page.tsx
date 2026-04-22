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
  | 'appearance'
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
    'appearance',
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
// Section content router — 3.2 live sections + 3.3 EmptySettingsSection + DangerZoneSection
// ---------------------------------------------------------------------------

import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { SourcesSection } from '@/components/settings/SourcesSection';
import { IngestFiltersSection } from '@/components/settings/IngestFiltersSection';
import { EntityExtractionSection } from '@/components/settings/EntityExtractionSection';
import { EmptySettingsSection } from '@/components/settings/EmptySettingsSection';
import { DangerZoneSection } from '@/components/settings/DangerZoneSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';

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

function SettingsSectionContent({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'sources':
      // Live section (3.2): connected integrations + ingest filters + entity extraction
      return (
        <div className="space-y-4">
          <SourcesSection />
          <IngestFiltersSection />
          <EntityExtractionSection />
        </div>
      );

    case 'appearance':
      // Live section (2.1): wash preference selector
      return <AppearanceSection />;

    case 'danger':
      // Live section (3.3): two-step data reset flow
      return <DangerZoneSection />;

    case 'profile':
    case 'brief-preferences':
    case 'privacy':
    case 'workspaces':
    case 'billing':
    case 'api-export': {
      const copy = EMPTY_SECTION_COPY[section] ?? {
        title: 'Coming soon',
        description: 'This section is under construction — check back soon.',
      };
      return <EmptySettingsSection title={copy.title} description={copy.description} />;
    }

    default:
      return (
        <div className="bg-bg-container border border-cloud-light px-8 py-10">
          <EmptyState
            icon={Construction}
            title="Coming soon"
            description="This section is under construction — check back soon."
          />
        </div>
      );
  }
}
