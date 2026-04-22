export const dynamic = 'force-dynamic';

/**
 * System page — /system (Cloudscape screen 6.4)
 *
 * RSC page: server-fetches system health snapshot, skills list, pipeline flows,
 * and MCP activity first page in parallel. Passes data to client tab components.
 *
 * 5-tab layout:
 *   1. Overview     — health strip + summary cards + queue depths + skill last-runs
 *   2. Queues       — BullMQ queue table with clear-failed action
 *   3. Skills       — skill list with trigger + schedule update
 *   4. Flows        — recent pipeline stage progressions
 *   5. MCP Activity — paginated MCP tool invocation log
 *
 * All data fetches use Promise.allSettled — partial failures render gracefully.
 */

import { PageHeader } from '@/components/design-system';
import { systemHealthApi, skillsListApi, mcpActivityApi } from '@/lib/api-client';
import type {
  SystemHealthSnapshot,
  SkillRecord,
  PipelineFlowEntry,
  ListEnvelope,
  McpActivityEntry,
} from '@/lib/api-client';
import { SystemTabs } from '@/components/system/SystemTabs';

// ---------------------------------------------------------------------------
// Empty-state fallbacks
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: SystemHealthSnapshot = {
  status: 'degraded',
  timestamp: new Date().toISOString(),
  uptime_s: 0,
  queues: [],
  redis_memory: { used_bytes: 0, max_bytes: 0, used_pct: 0, status: 'degraded' },
  monthly_spend: { month: '—', total_usd: 0, non_claude_usd: 0, status: 'healthy' },
  skill_last_runs: [],
  wiki: {
    configured: false,
    status: 'healthy',
    repo_url: null,
    page_count: 0,
    last_commit_date: null,
    last_commit_message: null,
    error: null,
  },
};

const EMPTY_MCP: ListEnvelope<McpActivityEntry> = {
  items: [],
  total: 0,
  limit: 25,
  offset: 0,
};

// ---------------------------------------------------------------------------
// RSC page
// ---------------------------------------------------------------------------

export default async function SystemPage() {
  const [snapshotResult, skillsResult, flowsResult, mcpResult] = await Promise.allSettled([
    systemHealthApi.snapshot(),
    skillsListApi.list(),
    systemHealthApi.flows(20),
    mcpActivityApi.list({ limit: 25, offset: 0 }),
  ]);

  const snapshot: SystemHealthSnapshot =
    snapshotResult.status === 'fulfilled' ? snapshotResult.value : EMPTY_SNAPSHOT;

  const skills: SkillRecord[] =
    skillsResult.status === 'fulfilled' ? skillsResult.value.skills : [];

  const flows: PipelineFlowEntry[] =
    flowsResult.status === 'fulfilled' ? flowsResult.value.flows : [];

  const mcpActivity: ListEnvelope<McpActivityEntry> =
    mcpResult.status === 'fulfilled' ? mcpResult.value : EMPTY_MCP;

  // Status summary for subtitle
  const statusLabel =
    snapshot.status === 'healthy'
      ? 'All systems operational'
      : snapshot.status === 'degraded'
        ? 'Some systems degraded'
        : 'Systems unhealthy';

  const totalFailed = snapshot.queues.reduce((s, q) => s + q.failed, 0);
  const subtitle = totalFailed > 0
    ? `${statusLabel} · ${totalFailed} failed job${totalFailed !== 1 ? 's' : ''}`
    : statusLabel;

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'System']}
        title="System"
        subtitle={subtitle}
      />

      <SystemTabs
        snapshot={snapshot}
        skills={skills}
        flows={flows}
        mcpActivity={mcpActivity}
      />
    </>
  );
}
