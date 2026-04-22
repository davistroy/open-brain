export const dynamic = 'force-dynamic';

import { GitMerge, Download, Plus } from 'lucide-react';
import { Button, PageHeader } from '@/components/design-system';
import { TypeFilterTabs } from '@/components/entities/TypeFilterTabs';
import { EntityTable } from '@/components/entities/EntityTable';
import { DistributionCard } from '@/components/entities/DistributionCard';
import { NeedsAttention } from '@/components/entities/NeedsAttention';
import { entitiesApi } from '@/lib/api-client';
import type { EntityType } from '@/lib/types';

// ---------------------------------------------------------------------------
// Tab definitions — order matches the prototype
// ---------------------------------------------------------------------------

const TAB_TYPES: Array<{ id: string; label: string }> = [
  { id: 'all',      label: 'All' },
  { id: 'person',   label: 'People' },
  { id: 'project',  label: 'Projects' },
  { id: 'topic',    label: 'Topics' },
  { id: 'org',      label: 'Organizations' },
  { id: 'decision', label: 'Decisions' },
];

/**
 * Entities list page — Screen 05.
 * Async RSC: reads searchParams.type, fetches from real API.
 * TypeFilterTabs uses Link-based navigation (URL-driven filter).
 * EntityTable client-side text search filters the already-loaded results.
 */
export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const params = await searchParams;
  const activeType = params.type ?? 'all';

  const entityType =
    activeType !== 'all' ? (activeType as EntityType) : undefined;

  const result = await entitiesApi.list({
    entity_type: entityType,
    limit: 200,
  });

  const entities = result.items;
  const total = result.total;

  // Build tab items with counts derived from API response.
  // The 'all' tab uses the total from the full (unfiltered) fetch.
  // Per-type counts are computed from the current result set if filtered,
  // or left undefined so TypeFilterTabs omits the badge.
  const tabItems = TAB_TYPES.map((tab) => ({
    ...tab,
    count: tab.id === 'all' ? total : undefined,
  }));

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Entities']}
        title="Entities"
        subtitle={`${total} people, projects, topics, organizations, and decisions extracted from your captures`}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<GitMerge size={12} strokeWidth={1.5} />}
            >
              Merge
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download size={12} strokeWidth={1.5} />}
            >
              Export
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={12} strokeWidth={2} />}
            >
              New entity
            </Button>
          </>
        }
      />

      {/* Type filter tabs — client component, URL-driven */}
      <TypeFilterTabs items={tabItems} activeType={activeType} />

      {/* Main 2-col grid */}
      <div
        className="grid gap-[24px]"
        style={{ gridTemplateColumns: '1fr 280px' }}
      >
        {/* Entity table — client component, local text search over entities prop */}
        <EntityTable entities={entities} />

        {/* Right sidebar */}
        <aside className="flex flex-col gap-[16px]">
          <DistributionCard entities={entities} />
          <NeedsAttention />
        </aside>
      </div>
    </>
  );
}
