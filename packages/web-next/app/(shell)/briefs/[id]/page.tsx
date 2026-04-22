export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/design-system';
import { BriefToc } from '@/components/briefs/BriefToc';
import { BriefReaderWrapper } from '@/components/briefs/BriefReaderWrapper';
import { BriefSources } from '@/components/briefs/BriefSources';
import { briefsApi, HttpError } from '@/lib/api-client';

/**
 * Brief reader page — Screen 08.
 * Dynamic route: fetches brief by ID from core-api.
 * Returns 404 if the brief does not exist.
 *
 * Layout: 3-column grid
 *   [220px BriefToc] [minmax(0, 720px) BriefReaderWrapper] [280px BriefSources]
 *   gap: 32px, align-items: start (sidebars sticky independently)
 *
 * Server component — BriefReaderWrapper is 'use client' for mark-as-read effect.
 */

interface BriefPageProps {
  params: Promise<{ id: string }>;
}

export default async function BriefPage({ params }: BriefPageProps) {
  const { id } = await params;

  let brief;
  try {
    brief = await briefsApi.get(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  // Format breadcrumb date from brief title or fall back to generated timestamp
  const breadcrumbDate = brief.title ?? `Brief ${id}`;

  // Parse estimated TTS duration from meta text ("... · X min read · ...").
  // Used by BriefToc to label the Listen button and seed the player duration.
  const minReadMatch = brief.meta?.match(/(\d+)\s*min\s*read/i);
  const estimatedDurationSecs = minReadMatch ? parseInt(minReadMatch[1]!, 10) * 60 : 0;

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Briefs', breadcrumbDate]}
      />

      <div
        className="grid gap-[32px] items-start"
        style={{ gridTemplateColumns: '220px minmax(0, 720px) 280px' }}
      >
        <BriefToc
          items={brief.toc}
          briefId={id}
          briefTitle={brief.title}
          estimatedDurationSecs={estimatedDurationSecs}
          bodyHtml={brief.body_html}
        />
        <BriefReaderWrapper brief={brief} />
        <BriefSources
          briefId={id}
          sources={brief.sources}
          sourceTotal={brief.source_total}
          refineOptions={brief.refine_options}
        />
      </div>
    </>
  );
}
