export const dynamic = 'force-dynamic';

import { RefreshCw, Download, Plus } from 'lucide-react';
import { Button, Container, PageHeader } from '@/components/design-system';
import { StatStrip } from '@/components/dashboard/StatStrip';
import { QuickCapture } from '@/components/dashboard/QuickCapture';
import { RecentCaptures } from '@/components/dashboard/RecentCaptures';
import { OpenQuestions } from '@/components/dashboard/OpenQuestions';
import { UpcomingBriefs } from '@/components/dashboard/UpcomingBriefs';
import { DashboardEmptyState } from '@/components/dashboard/DashboardEmptyState';
import { capturesApi, statsApi, intelligenceApi, briefsApi } from '@/lib/api-client';
import { mapStatsToDashboard, mapToOpenQuestions, mapToUpcomingBriefs } from '@/lib/dashboard-mappers';

/**
 * Dashboard page — Screen 01.
 * Async RSC: fetches stats, captures, unresolved questions, and briefs in parallel.
 * Layout: StatStrip → 2-col grid (left: QuickCapture + RecentCaptures | right: OpenQuestions + UpcomingBriefs)
 */
export default async function DashboardPage() {
  const [statsRaw, capturesEnvelope, questionsRaw, briefsEnvelope] = await Promise.all([
    statsApi.get(),
    capturesApi.list({ limit: 8 }),
    intelligenceApi.unresolvedQuestions(4),
    briefsApi.list({ limit: 3 }),
  ]);

  // Zero-captures empty state — shown when the brain has no data yet
  if (statsRaw.total_captures === 0) {
    return <DashboardEmptyState />;
  }

  const stats = mapStatsToDashboard(statsRaw);
  const captures = capturesEnvelope.items;
  const openQuestions = mapToOpenQuestions(questionsRaw.questions);
  const upcomingBriefs = mapToUpcomingBriefs(briefsEnvelope.items);

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Dashboard']}
        title="Good morning, Troy"
        subtitle={`${stats.captures_7d} total captures · ${openQuestions.length} open questions · pipeline ${stats.pipeline_status}`}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={13} strokeWidth={1.5} />}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download size={13} strokeWidth={1.5} />}
            >
              Export
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={13} strokeWidth={2} />}
            >
              New brief
            </Button>
          </>
        }
      />

      <StatStrip stats={stats} />

      {/* 2-column dashboard grid */}
      <div
        className="grid gap-[20px]"
        style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)' }}
      >
        {/* Left column */}
        <div className="flex flex-col gap-[20px]">
          <Container
            header="Quick capture"
            description="Drop a thought — Open Brain handles transcription, entity extraction, linking."
            padding={false}
          >
            <QuickCapture />
          </Container>

          <Container
            header={
              <>
                Recent activity{' '}
                <span className="font-mono text-[12px] font-normal text-text-body-secondary tracking-[0.02em]">
                  ({captures.length})
                </span>
              </>
            }
            description="Last 48 hours across all sources."
            actions={
              <>
                <Button variant="secondary" size="sm">
                  Filter
                </Button>
                <Button variant="ghost" size="sm">
                  View all →
                </Button>
              </>
            }
            padding={false}
          >
            <RecentCaptures captures={captures} />
          </Container>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-[20px]">
          <Container
            header="Open questions"
            description="Unresolved threads Open Brain surfaced."
            actions={
              <Button variant="ghost" size="sm">
                Board →
              </Button>
            }
            padding={false}
          >
            <OpenQuestions questions={openQuestions} />
          </Container>

          <Container
            header="Upcoming briefs"
            actions={
              <Button variant="ghost" size="sm">
                All briefs →
              </Button>
            }
            padding={false}
          >
            <UpcomingBriefs briefs={upcomingBriefs} />
          </Container>
        </div>
      </div>
    </>
  );
}
