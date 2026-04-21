import { RefreshCw, Download, Plus } from 'lucide-react';
import { Button, Container, PageHeader } from '@/components/design-system';
import { StatStrip } from '@/components/dashboard/StatStrip';
import { QuickCapture } from '@/components/dashboard/QuickCapture';
import { RecentCaptures } from '@/components/dashboard/RecentCaptures';
import { OpenQuestions } from '@/components/dashboard/OpenQuestions';
import { UpcomingBriefs } from '@/components/dashboard/UpcomingBriefs';
import {
  mockStats,
  mockCaptures,
  mockOpenQuestions,
  mockUpcomingBriefs,
} from '@/lib/mock-data';

/**
 * Dashboard page — Screen 01.
 * Server component: composes all dashboard sub-components with mock data.
 * Layout: StatStrip → 2-col grid (left: QuickCapture + RecentCaptures | right: OpenQuestions + UpcomingBriefs)
 */
export default function DashboardPage() {
  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Dashboard']}
        title="Good morning, Troy"
        subtitle="Tuesday, April 21 · 47 captures this week · 3 open briefs"
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

      <StatStrip stats={mockStats} />

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
                  ({mockCaptures.slice(0, 8).length})
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
            <RecentCaptures captures={mockCaptures} />
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
            <OpenQuestions questions={mockOpenQuestions} />
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
            <UpcomingBriefs briefs={mockUpcomingBriefs} />
          </Container>
        </div>
      </div>
    </>
  );
}
