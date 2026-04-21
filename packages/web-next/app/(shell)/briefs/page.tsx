import { Clock, Plus } from 'lucide-react';
import { Button, PageHeader } from '@/components/design-system';
import { BriefHero } from '@/components/briefs/BriefHero';
import { BriefLibrary } from '@/components/briefs/BriefLibrary';
import { mockBriefs, mockTuesdayBrief } from '@/lib/mock-data';

/**
 * Briefs library page — Screen 07.
 * Server component: composes BriefHero + BriefLibrary with mock data.
 * Layout: PageHeader → BriefHero (latest daily) → BriefLibrary (filter + grid/list)
 */
export default function BriefsPage() {
  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Briefs']}
        title="Briefs"
        subtitle="AI-generated summaries — daily, weekly, and on-demand dossiers"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Clock size={12} strokeWidth={1.5} />}
            >
              Schedule
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={12} strokeWidth={2} />}
            >
              New brief
            </Button>
          </>
        }
      />

      {/* Hero: today's daily brief — warm paper block */}
      <BriefHero brief={mockTuesdayBrief} />

      {/* Library: filter tabs + grid/list toggle */}
      <BriefLibrary briefs={mockBriefs} />
    </>
  );
}
