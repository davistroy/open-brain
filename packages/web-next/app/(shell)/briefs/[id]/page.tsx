import { PageHeader } from '@/components/design-system';
import { BriefToc } from '@/components/briefs/BriefToc';
import { BriefReader } from '@/components/briefs/BriefReader';
import { BriefSources } from '@/components/briefs/BriefSources';
import { mockTuesdayBrief } from '@/lib/mock-data';

/**
 * Brief reader page — Screen 08.
 * Dynamic route: all IDs resolve to mockTuesdayBrief in M1.
 * M2 note: swap fixture lookup for real API fetch by id param.
 *
 * Layout: 3-column grid
 *   [220px BriefToc] [minmax(0, 720px) BriefReader] [280px BriefSources]
 *   gap: 32px, align-items: start (sidebars sticky independently)
 *
 * Server component.
 */

interface BriefPageProps {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return [{ id: 'tuesday-brief' }];
}

export default async function BriefPage({ params }: BriefPageProps) {
  // In M1 all IDs serve the same fixture.
  // params is awaited per Next.js 15 App Router async params convention.
  await params; // consume to satisfy type; value unused in M1

  const brief = mockTuesdayBrief;

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Briefs', 'Tue, Apr 21']}
      />

      <div
        className="grid gap-[32px] items-start"
        style={{ gridTemplateColumns: '220px minmax(0, 720px) 280px' }}
      >
        <BriefToc items={brief.toc} />
        <BriefReader brief={brief} />
        <BriefSources
          sources={brief.sources}
          sourceTotal={brief.source_total}
          refineOptions={brief.refine_options}
        />
      </div>
    </>
  );
}
