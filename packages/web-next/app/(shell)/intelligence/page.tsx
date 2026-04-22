export const dynamic = 'force-dynamic';

import { Brain } from 'lucide-react';
import { PageHeader, EmptyState } from '@/components/design-system';
import { SkillCard } from '@/components/intelligence/SkillCard';
import { intelligenceApi } from '@/lib/api-client';
import type { IntelligenceSummaryResponse } from '@/lib/api-client';

/**
 * Intelligence page — Screen 05 (Cloudscape M3 Phase 5 item 5.2).
 *
 * Async RSC: fetches the latest connections + drift skill results from
 * /api/v1/intelligence/summary in a single request, then renders two
 * SkillCard client components — one per intelligence skill — each with
 * a "Run now" trigger button.
 *
 * Layout: PageHeader → 2-column card grid (ConnectionsCard | DriftCard)
 */
export default async function IntelligencePage() {
  let summary: IntelligenceSummaryResponse = { connections: null, drift: null };

  try {
    summary = await intelligenceApi.summary();
  } catch {
    // Leave summary with nulls — cards show "Never run" state
  }

  const hasAnyData = summary.connections !== null || summary.drift !== null;

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Intelligence']}
        title="Intelligence"
        subtitle="Proactive analysis skills — connections between captures, drift from your stated goals, and open questions."
      />

      {/* Two-column card grid */}
      <div className="grid gap-[20px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        {/* Connections card */}
        <SkillCard
          skill="daily-connections"
          lastRun={summary.connections}
          description="Surfaces non-obvious relationships between recent captures — emerging themes, contradictions, and overlooked links."
        />

        {/* Drift card */}
        <SkillCard
          skill="drift-monitor"
          lastRun={summary.drift}
          description="Compares your recent activity against commitments and goals, flagging areas where execution has diverged from intent."
        />
      </div>

      {/* Contextual note — shown when nothing has run yet */}
      {!hasAnyData && (
        <div className="mt-[32px]">
          <EmptyState
            icon={Brain}
            title="No intelligence runs yet"
            description="Click 'Run now' on either card to generate an initial analysis. Skills also run on their scheduled cron — connections daily at 06:10, drift daily at 07:15."
          />
        </div>
      )}
    </>
  );
}
