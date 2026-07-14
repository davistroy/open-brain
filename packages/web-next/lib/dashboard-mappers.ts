/**
 * Pure data-mapping helpers for the dashboard page.
 *
 * Converts raw core-api response shapes into the display types expected
 * by StatStrip, OpenQuestions, and UpcomingBriefs.
 *
 * All functions are synchronous and have no side-effects — safe to call
 * in any RSC or test without mocking.
 */

import type { StatsResponse, briefsApi } from '@/lib/api-client';
import type { DashboardStats, OpenQuestion, ServiceHealthStatus, UpcomingBrief } from '@/lib/types';

/**
 * Pipeline health-label thresholds (issue #200).
 *
 * The health LABEL reflects the pipeline's live ability to process, decoupled
 * from the stale all-time terminal-failure count (which is surfaced separately
 * as `pipeline_failed`). A handful of months-old failed captures must NOT pin
 * the label to "degraded" forever — recent-failure alerting is owned by the
 * workers `pipeline-health` skill (Pushover), not the dashboard. A genuine
 * failure flood or a real queue backlog still degrades/downs the label.
 *
 * Tunable in one place; `derivePipelineStatus` is the single source of truth.
 */
const PIPELINE_FAILED_UNHEALTHY = 50; // > this many all-time terminal failures ⇒ unhealthy
const PIPELINE_PENDING_UNHEALTHY = 100; // > this deep a live backlog ⇒ unhealthy
const PIPELINE_PENDING_DEGRADED = 50; // > this deep a live backlog ⇒ degraded

/**
 * Derive the pipeline health label from the live backlog and the all-time
 * terminal-failure count. Pure and exported so the threshold policy is unit-
 * testable directly (see dashboard-mappers.test.ts).
 */
export function derivePipelineStatus(failed: number, pending: number): ServiceHealthStatus {
  if (failed > PIPELINE_FAILED_UNHEALTHY || pending > PIPELINE_PENDING_UNHEALTHY) return 'unhealthy';
  if (pending > PIPELINE_PENDING_DEGRADED) return 'degraded';
  return 'healthy';
}

/**
 * Map the raw StatsResponse from GET /api/v1/stats into the DashboardStats
 * shape expected by StatStrip. The API returns aggregate counts; we synthesise
 * delta strings using a simple ±N% heuristic (no prior-period data available
 * from the stats endpoint — stubs show a neutral ◆ indicator).
 */
export function mapStatsToDashboard(raw: StatsResponse): DashboardStats {
  const pending = raw.pipeline_health.pending ?? 0;
  const processing = raw.pipeline_health.processing ?? 0;
  const failed = raw.pipeline_health.failed ?? 0;

  const pipeline_status = derivePipelineStatus(failed, pending);

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
    pipeline_failed: failed,
    llm_spend_usd: 0,
    capture_total: raw.total_captures,
    entity_total: 0,
  };
}

/**
 * Map intelligence unresolved-questions response items to the OpenQuestion UI type.
 */
export function mapToOpenQuestions(
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
export function mapToUpcomingBriefs(
  items: Awaited<ReturnType<typeof briefsApi.list>>['items'],
): UpcomingBrief[] {
  return items.map((brief) => ({
    id: brief.id,
    title: brief.title,
    progress: 0,
    due: brief.generated_at
      ? new Date(brief.generated_at).toLocaleDateString('en-US', {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—',
    source_count: 0,
  }));
}
