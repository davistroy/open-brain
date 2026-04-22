export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { PageHeader, Card, Button } from '@/components/design-system';
import { EntityDetailClient } from '@/components/entity/entity-detail-client';
import { EntityTabs } from '@/components/entity/entity-tabs';
import { AISummary } from '@/components/entity/ai-summary';
import { CommitmentsCard } from '@/components/entity/commitments-card';
import { CaptureItem } from '@/components/entity/capture-item';
import { RelationshipGraph } from '@/components/entity/relationship-graph';
import { MentionsChart } from '@/components/entity/mentions-chart';
import { RelatedEntities } from '@/components/entity/related-entities';
import { entitiesApi, HttpError } from '@/lib/api-client';

/**
 * Entity detail page — async RSC with parallel fetches.
 * Calls notFound() for any 404 response from the API.
 * Modal state (Ask AI, Merge) is owned by EntityDetailClient.
 */
export default async function EntityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Parallel fetch: entity detail + related entities + mentions timeline (90d, weekly)
  // entity fetch is critical-path; others gracefully degrade on failure.
  let entity;
  try {
    entity = await entitiesApi.get(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  // Non-critical fetches — fail silently with empty defaults
  const [relatedResult, timelineResult] = await Promise.allSettled([
    entitiesApi.related(id, { limit: 10 }),
    entitiesApi.mentionsTimeline(id, { window: '90d', bucket: 'week' }),
  ]);

  const relatedEntities =
    relatedResult.status === 'fulfilled'
      ? relatedResult.value.items
      : entity.related_entities ?? [];

  const mentionBuckets =
    timelineResult.status === 'fulfilled'
      ? timelineResult.value.buckets
      : [];

  const initials = entity.name
    .split(' ')
    .map((w: string) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Entities', entity.name]}
      />

      {/* Client shell: owns modal state, renders EntityHeader + modals */}
      <EntityDetailClient entity={entity} />

      <EntityTabs />

      {/* 2-col layout: main | sidebar */}
      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}
      >
        {/* Left column */}
        <div>
          <AISummary summary={entity.summary} updatedAt={entity.summary_updated_at} />

          <CommitmentsCard />

          <div className="h-5" />

          {/* Recent captures mentioning entity */}
          {entity.captures && entity.captures.length > 0 && (
            <Card
              header={`Recent captures mentioning ${entity.name.split(' ')[0]}`}
              actions={
                <Button variant="ghost" size="sm">
                  View all {entity.mention_count} →
                </Button>
              }
              padded
            >
              {entity.captures.map((capture, i) => (
                <CaptureItem
                  key={capture.id}
                  capture={capture}
                  isLast={i === entity.captures.length - 1}
                />
              ))}
            </Card>
          )}
        </div>

        {/* Right sidebar */}
        <aside className="flex flex-col gap-4">
          <Card
            header="Relationship graph"
            description="Top co-mentioned entities"
            padded={false}
          >
            <RelationshipGraph entities={relatedEntities} initials={initials} />
          </Card>

          <Card header="Mentions over time" padded>
            <MentionsChart buckets={mentionBuckets} totalBuckets={13} />
          </Card>

          <RelatedEntities entities={relatedEntities} />
        </aside>
      </div>
    </>
  );
}
