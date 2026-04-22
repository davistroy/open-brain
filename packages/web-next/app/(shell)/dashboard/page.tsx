export const dynamic = 'force-dynamic';

import { RefreshCw, Download, Plus } from 'lucide-react';
import { Button, Container, PageHeader } from '@/components/design-system';
import { StatStrip } from '@/components/dashboard/StatStrip';
import { QuickCapture } from '@/components/dashboard/QuickCapture';
import { RecentCaptures } from '@/components/dashboard/RecentCaptures';
import { OpenQuestions } from '@/components/dashboard/OpenQuestions';
import { UpcomingBriefs } from '@/components/dashboard/UpcomingBriefs';
import { capturesApi, statsApi, intelligenceApi, briefsApi } from '@/lib/api-client';
import type { StatsResponse } from '@/lib/api-client';
import type { DashboardStats, OpenQuestion, UpcomingBrief } from '@/lib/types';

/**
 * Map the raw StatsResponse from GET /api/v1/stats into the DashboardStats
 * shape expected by StatStrip. The API returns aggregate counts; we synthesise
 * delta strings using a simple ±N% heuristic (no prior-period data available
 * from the stats endpoint — stubs show a neutral ◆ indicator).
 */
function mapStatsToDashboard(raw: StatsResponse): DashboardStats {
  const pending = raw.pipeline_health.pending ?? 0;
  const processing = raw.pipeline_health.processing ?? 0;
  const failed = raw.pipeline_health.failed ?? 0;

  const pipeline_status: 'healthy' | 'degraded' | 'unhealthy' =
    failed > 10 ? 'unhealthy' : failed > 0 || pending > 50 ? 'degraded' : 'healthy';

  return {
    captures_7d: raw.total_captures,
    captures_7d_delta: '◆ 0%',
    captures_7d_meta: `${raw.total_captures} total captures`,
    active_entities: 0,
    active_entities_delta: '◆ 0%',
    active_entities_meta: '',
    open_questions: 0,
    open_questions_delta: '◆ 0%',
    open_questions_meta: '',
    briefs_in_progress: 0,
    briefs_due_meta: '',
    pipeline_status,
    pipeline_active: processing,
    pipeline_queued: pending,
    llm_spend_usd: 0,
    capture_total: raw.total_captures,
    entity_total: 0,
  };
}

/**
 * Map intelligence unresolved-questions response items to the OpenQuestion UI type.
 */
function mapToOpenQuestions(
  items: Array<{ id: string; content: string; brain_view: string; created_at: string }>,
): OpenQuestion[] {
  return items.map((item) => ({
    id: item.id,
    question: item.content,
    due: 'flex',
    priority: 'med' as const,
    context: item.brain_view,
  }));
}

/**
 * Map Brief list items to the UpcomingBrief display type.
 * The briefs endpoint returns the full Brief card shape; UpcomingBrief needs
 * progress + source_count which are not in the list envelope — stub at 0.
 */
function mapToUpcomingBriefs(items: Awaited<ReturnType<typeof briefsApi.list>>['items']): UpcomingBrief[] {
  return items.map((brief) => ({
    id: brief.id,
    title: brief.title,
    progress: 0,
    due: brief.generated,
    source_count: 0,
  }));
}

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
