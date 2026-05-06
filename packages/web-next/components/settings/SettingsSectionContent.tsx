/**
 * SettingsSectionContent — renders the right-hand content panel for the
 * active settings section.
 *
 * Extracted from settings/page.tsx to keep the page file under 200 LOC.
 * Server component: all child section components handle their own client
 * state via 'use client' where needed.
 */

import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import { SourcesSection } from '@/components/settings/SourcesSection';
import { IngestFiltersSection } from '@/components/settings/IngestFiltersSection';
import { EntityExtractionSection } from '@/components/settings/EntityExtractionSection';
import { EmptySettingsSection } from '@/components/settings/EmptySettingsSection';
import { DangerZoneSection } from '@/components/settings/DangerZoneSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { TriggersSection } from '@/components/settings/TriggersSection';
import { AIRoutingSection } from '@/components/settings/AIRoutingSection';
import { EmailAllowlistSection } from '@/components/settings/EmailAllowlistSection';
import { EmailConfigSection } from '@/components/settings/EmailConfigSection';
import { ServiceHealthSection } from '@/components/settings/ServiceHealthSection';
import { VersionUptimeSection } from '@/components/settings/VersionUptimeSection';
import { VoiceSection } from '@/components/settings/VoiceSection';
import { WikiSection } from '@/components/settings/WikiSection';
import type { SettingsSection } from '@/app/(shell)/settings/page';

/** Copy map for empty-state sections — editorial voice */
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

// ---------------------------------------------------------------------------
// Section content router — live sections + EmptySettingsSection + DangerZoneSection
// ---------------------------------------------------------------------------

export function SettingsSectionContent({ section }: { section: SettingsSection }) {
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

    case 'triggers':
      // Live section (7.3): semantic trigger list + create/delete
      return <TriggersSection />;

    case 'ai-routing':
      // Live section (7.3): AI routing table + budget meter
      return <AIRoutingSection />;

    case 'email-config':
      // Live section (7.3): email inbound/outbound channel health
      return <EmailConfigSection />;

    case 'email-allowlist':
      // Live section (7.3): email sender allowlist CRUD
      return <EmailAllowlistSection />;

    case 'voice':
      // Live section (7.3): voice integration status + session counts
      return <VoiceSection />;

    case 'wiki':
      // Live section (7.3): wiki repo health + stats
      return <WikiSection />;

    case 'service-health':
      // Live section (7.3): core dependency health (postgres, redis, llm)
      return <ServiceHealthSection />;

    case 'version-uptime':
      // Live section (7.3): build version + uptime
      return <VersionUptimeSection />;

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
