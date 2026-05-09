'use client';

/**
 * WikiSection — Settings page wiki status display.
 *
 * Read-only status section showing: Gitea repo health, page count, last sync,
 * lint schedule, last lint run, and auto-ingest skill status.
 *
 * API surface:
 *   GET /api/v1/wiki/stats         → WikiStats  (page_count, last_updated, last_lint_run)
 *   GET /api/v1/system/health      → SystemHealthSnapshot  (.wiki.{configured,status,repo_url})
 *   GET /api/v1/skills             → { skills: SkillRecord[] }  (wiki-lint schedule)
 *
 * Patterns (following TriggersSection exemplar):
 * - Data via TanStack Query useQuery; no mutations (read-only status section).
 * - Two queries: wikiApi.stats() for stat rows; systemHealthApi.snapshot() for
 *   repo health + skill_last_runs; skillsListApi.list() for cron schedules.
 * - Error UI: inline alert div with status-error CSS vars.
 * - Loading UI: skeleton pulse rows matching real row shape.
 * - Card wrapper with padded={false}; rows in divide-y container.
 * - Client component required (useQuery hook).
 *
 * UX parity with packages/web/src/components/settings/WikiSection.tsx:
 * - Gitea repo row: status dot + repo URL or "Not configured".
 * - Page count, Last sync, Lint schedule, Last lint, Auto-ingest badge rows.
 * - Auto-ingest badge: Enabled (default) / Disabled based on wiki-ingest/wiki-synthesis skill schedule.
 */

import { BookOpen, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/design-system/Card';
import { StatusDot } from '@/components/design-system/StatusDot';
import { useWikiStats } from '@/lib/api/wiki.hooks';
import { useSystemHealthSnapshot } from '@/lib/api/system-health.hooks';
import { useSkillsList } from '@/lib/api/skills.hooks';
import type { SystemHealthSnapshot, SkillRecord } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map WikiHealthStatus.status to StatusDot variant. */
function wikiHealthToDotStatus(
  status: SystemHealthSnapshot['wiki']['status'],
  configured: boolean,
): 'success' | 'warning' | 'error' | 'neutral' {
  if (!configured) return 'neutral';
  if (status === 'healthy')   return 'success';
  if (status === 'degraded')  return 'warning';
  if (status === 'unhealthy') return 'error';
  return 'neutral';
}

/** Format an ISO 8601 timestamp for display, returning '—' on null/undefined. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// ErrorAlert — inline error block matching DangerZoneSection / TriggersSection
// ---------------------------------------------------------------------------

function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-3 px-[18px] py-[14px] border border-[var(--color-status-error-border)] bg-[var(--color-status-error-bg)]"
      role="alert"
    >
      <TriangleAlert
        size={14}
        strokeWidth={1.5}
        className="text-[var(--color-status-error-fg)] shrink-0 mt-[1px]"
      />
      <p className="text-[12.5px] text-[var(--color-status-error-fg)] font-light leading-[1.5]">
        {message}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonRow — pulse row during initial load
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[13px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <div className="h-[12px] w-[110px] bg-cloud-light animate-pulse" />
      <div className="h-[12px] w-[180px] bg-cloud-light animate-pulse opacity-60" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusRow — single key/value display row
// ---------------------------------------------------------------------------

function StatusRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-[18px] py-[13px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <span className="text-[12.5px] text-text-body-secondary font-light shrink-0">{label}</span>
      <div className="text-[12px] text-text-body font-mono flex items-center gap-[6px] min-w-0 text-right">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutoIngestBadge — Enabled / Disabled pill
// ---------------------------------------------------------------------------

function AutoIngestBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center px-[6px] py-[1px] text-[10.5px] font-medium tracking-[0.02em]',
        enabled
          ? 'bg-[var(--color-status-success-bg)] border border-[var(--color-status-success-border)] text-[var(--color-status-success-fg)]'
          : 'bg-cloud-light border border-cloud-dark text-text-small',
      ].join(' ')}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// WikiSection — main exported component
// ---------------------------------------------------------------------------

export function WikiSection() {
  // ── Wiki stats ────────────────────────────────────────────────────────────
  const statsQuery = useWikiStats();

  // ── System health snapshot (for repo URL + connection status) ─────────────
  const healthQuery = useSystemHealthSnapshot();

  // ── Skills list (for wiki-lint schedule and auto-ingest skill presence) ───
  const skillsQuery = useSkillsList();

  const isLoading = statsQuery.isLoading || healthQuery.isLoading || skillsQuery.isLoading;
  const isError   = statsQuery.isError   || healthQuery.isError;

  // Derived data
  const stats          = statsQuery.data;
  const wikiHealth     = healthQuery.data?.wiki;
  const skills         = skillsQuery.data?.skills ?? [];

  const wikiLintSkill   = skills.find((s) => s.name === 'wiki-lint');
  const wikiIngestSkill = skills.find(
    (s) => s.name === 'wiki-ingest' || s.name === 'wiki-synthesis',
  );

  const giteaConfigured = wikiHealth?.configured ?? false;
  const giteaRepoUrl    = wikiHealth?.repo_url ?? null;
  const dotStatus       = wikiHealthToDotStatus(
    wikiHealth?.status ?? 'unhealthy',
    giteaConfigured,
  );

  const errorMessage = (() => {
    if (statsQuery.isError && statsQuery.error instanceof Error) return statsQuery.error.message;
    if (healthQuery.isError && healthQuery.error instanceof Error) return healthQuery.error.message;
    return 'Failed to load wiki status. Try refreshing.';
  })();

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Card
      header={
        <span className="flex items-center gap-[6px]">
          <BookOpen size={14} strokeWidth={1.5} className="text-text-small shrink-0" />
          Wiki
        </span>
      }
      description="Gitea-backed knowledge graph — synthesis status and lint health."
      padded={false}
    >
      {/* ── Load error ──────────────────────────────────────────────────── */}
      {isError && <ErrorAlert message={errorMessage} />}

      {/* ── Loading skeleton ────────────────────────────────────────────── */}
      {isLoading && !isError && (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── Data rows ───────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="divide-y divide-cloud-light">
          {/* Gitea repo + health status */}
          <StatusRow label="Gitea Repo">
            <StatusDot status={dotStatus} />
            <span className="truncate max-w-[260px] font-mono text-[11.5px] text-text-body-secondary">
              {giteaRepoUrl ?? 'Not configured'}
            </span>
          </StatusRow>

          {/* Page count */}
          <StatusRow label="Page Count">
            <span className="font-mono text-[12px]">
              {stats?.page_count !== undefined ? String(stats.page_count) : '—'}
            </span>
          </StatusRow>

          {/* Orphan pages */}
          {stats?.orphan_count !== undefined && stats.orphan_count > 0 && (
            <StatusRow label="Orphan Pages">
              <span className="font-mono text-[12px] text-[var(--color-status-warning-fg)]">
                {stats.orphan_count}
              </span>
            </StatusRow>
          )}

          {/* Last sync (last_commit_date from health, or last_updated from stats) */}
          <StatusRow label="Last Sync">
            <span className="text-[11.5px] text-text-body-secondary">
              {fmtDate(wikiHealth?.last_commit_date ?? stats?.last_updated)}
            </span>
          </StatusRow>

          {/* Lint schedule (from wiki-lint skill) */}
          <StatusRow label="Lint Schedule">
            <span className="font-mono text-[11.5px]">
              {wikiLintSkill?.schedule ?? '—'}
            </span>
          </StatusRow>

          {/* Last lint run */}
          <StatusRow label="Last Lint">
            <span className="text-[11.5px] text-text-body-secondary">
              {fmtDate(stats?.last_lint_run)}
            </span>
          </StatusRow>

          {/* Auto-ingest badge (wiki-ingest or wiki-synthesis skill presence + schedule) */}
          {wikiIngestSkill !== undefined && (
            <StatusRow label="Auto-ingest">
              <AutoIngestBadge enabled={!!wikiIngestSkill.schedule} />
            </StatusRow>
          )}
        </div>
      )}
    </Card>
  );
}
