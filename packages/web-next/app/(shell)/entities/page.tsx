'use client';

import { useState } from 'react';
import { GitMerge, Download, Plus } from 'lucide-react';
import { Button, PageHeader } from '@/components/design-system';
import { TypeFilterTabs } from '@/components/entities/TypeFilterTabs';
import { EntityTable } from '@/components/entities/EntityTable';
import { DistributionCard } from '@/components/entities/DistributionCard';
import { NeedsAttention } from '@/components/entities/NeedsAttention';
import {
  mockEntities,
  mockEntityTypeCounts,
  mockEntityDistribution,
  mockNeedsAttention,
} from '@/lib/mock-data';
import type { EntityType } from '@/lib/types';

// ---------------------------------------------------------------------------
// Tab definitions — order matches the prototype
// ---------------------------------------------------------------------------

const TAB_ITEMS = [
  { id: 'all',      label: 'All',           count: mockEntityTypeCounts.all },
  { id: 'person',   label: 'People',        count: mockEntityTypeCounts.person },
  { id: 'project',  label: 'Projects',      count: mockEntityTypeCounts.project },
  { id: 'topic',    label: 'Topics',        count: mockEntityTypeCounts.topic },
  { id: 'org',      label: 'Organizations', count: mockEntityTypeCounts.org },
  { id: 'decision', label: 'Decisions',     count: mockEntityTypeCounts.decision },
];

/**
 * Entities list page — Screen 05.
 * Lifts type-filter state; filters mockEntities client-side.
 * Layout: TypeFilterTabs → 2-col grid (EntityTable | sidebar)
 *
 * 'use client' because the type filter drives the table display.
 */
export default function EntitiesPage() {
  const [activeType, setActiveType] = useState<string>('all');

  const filteredEntities =
    activeType === 'all'
      ? mockEntities
      : mockEntities.filter((e) => e.entity_type === (activeType as EntityType));

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Entities']}
        title="Entities"
        subtitle="217 people, projects, topics, organizations, and decisions extracted from your captures"
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

      {/* Type filter tabs */}
      <TypeFilterTabs
        items={TAB_ITEMS}
        active={activeType}
        onChange={setActiveType}
      />

      {/* Main 2-col grid */}
      <div
        className="grid gap-[24px]"
        style={{ gridTemplateColumns: '1fr 280px' }}
      >
        {/* Entity table */}
        <EntityTable entities={filteredEntities} />

        {/* Right sidebar */}
        <aside className="flex flex-col gap-[16px]">
          <DistributionCard distribution={mockEntityDistribution} />
          <NeedsAttention items={mockNeedsAttention} />
        </aside>
      </div>
    </>
  );
}
