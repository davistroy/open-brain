import { PageHeader, Card, Button } from '@/components/design-system';
import { EntityHeader } from '@/components/entity/entity-header';
import { EntityTabs } from '@/components/entity/entity-tabs';
import { AISummary } from '@/components/entity/ai-summary';
import { CommitmentsCard } from '@/components/entity/commitments-card';
import { CaptureItem } from '@/components/entity/capture-item';
import { RelationshipGraph } from '@/components/entity/relationship-graph';
import { MentionsChart } from '@/components/entity/mentions-chart';
import { RelatedEntities } from '@/components/entity/related-entities';
import { mockSarahChen } from '@/lib/mock-data';

/**
 * Pre-build the sarah-chen route at build time.
 * M2 will replace this with a real data fetch by [id].
 */
export function generateStaticParams() {
  return [{ id: 'sarah-chen' }];
}

export default function EntityDetailPage() {
  // M1: all IDs resolve to the Sarah Chen fixture.
  const entity = mockSarahChen;

  const initials = entity.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Entities', entity.name]}
      />

      <EntityHeader entity={entity} />

      <EntityTabs />

      {/* 2-col layout: main | sidebar */}
      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}
      >
        {/* Left column */}
        <div>
          <AISummary summary={entity.summary} updatedAt={entity.summary_updated_at} />

          <CommitmentsCard commitments={entity.commitments} />

          <div className="h-5" />

          {/* Recent captures mentioning entity */}
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
        </div>

        {/* Right sidebar */}
        <aside className="flex flex-col gap-4">
          <Card
            header="Relationship graph"
            description="Top co-mentioned entities"
            padded={false}
          >
            <RelationshipGraph entities={entity.related_entities} initials={initials} />
          </Card>

          <Card header="Mentions over time" padded>
            <MentionsChart />
          </Card>

          <RelatedEntities entities={entity.related_entities} />
        </aside>
      </div>
    </>
  );
}
