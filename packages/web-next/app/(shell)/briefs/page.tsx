import { Clock, Plus } from 'lucide-react';
import { Button, PageHeader } from '@/components/design-system';
import { BriefHero } from '@/components/briefs/BriefHero';
import { BriefLibrary } from '@/components/briefs/BriefLibrary';
import { briefsApi } from '@/lib/api-client';
import type { Brief } from '@/lib/types';

/**
 * Briefs library page — Screen 07.
 * Async RSC: fetches briefs from core-api, computes hero brief,
 * passes data to client components.
 * Layout: PageHeader → BriefHero (latest unread daily) → BriefLibrary (filter + grid/list)
 */
export default async function BriefsPage() {
  let briefs: Brief[] = [];

  try {
    const envelope = await briefsApi.list({ limit: 20 });
    briefs = envelope.items;
  } catch {
    // Leave briefs empty — library shows empty state, hero is hidden
  }

  // Hero = first brief where not read and not dismissed, else first in list
  const hero =
    briefs.find((b) => !b.read_at && !b.dismissed_at) ?? briefs[0] ?? null;

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

      {/* Hero: latest unread brief — warm paper block */}
      {hero && <BriefHero brief={hero} />}

      {/* Library: filter tabs + grid/list toggle */}
      <BriefLibrary briefs={briefs} />
    </>
  );
}
