'use client';

/**
 * OverviewTab — System page tab 1.
 *
 * Displays:
 * - Health strip: one StatusDot per service dependency (postgres, redis, llm)
 * - Queue depth summary: total waiting + failed across all monitored queues
 * - Redis memory bar
 * - Monthly LLM spend (non-Claude USD vs threshold)
 * - Skill last-run summary table
 * - Wiki health status row
 *
 * All data is passed as props from the RSC page (server-prefetched).
 * Client component only for the refresh button (which triggers a full page reload).
 */

import { RefreshCw, Database, Zap, Server, BookOpen } from 'lucide-react';
import { Button, StatusDot } from '@/components/design-system';
import type {
  SystemHealthSnapshot,
  QueueStats,
  SkillLastRun,
} from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HealthLevel = 'healthy' | 'degraded' | 'unhealthy';

function healthToDotStatus(h: HealthLevel): 'success' | 'warning' | 'error' {
  if (h === 'healthy') return 'success';
  if (h === 'degraded') return 'warning';
  return 'error';
}

function healthLabel(h: HealthLevel): string {
  if (h === 'healthy') return 'Healthy';
  if (h === 'degraded') return 'Degraded';
  return 'Unhealthy';
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'Just now';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HealthStrip({ snapshot }: { snapshot: SystemHealthSnapshot }) {
  // We derive service dots from the basic health endpoint services if available.
  // System health snapshot exposes overall + queue/redis/spend statuses.
  const services: Array<{ label: string; status: HealthLevel; icon: React.ReactNode }> = [
    {
      label: 'Redis',
      status: snapshot.redis_memory.status,
      icon: <Database size={12} strokeWidth={1.5} />,
    },
    {
      label: 'LLM Spend',
      status: snapshot.monthly_spend.status,
      icon: <Zap size={12} strokeWidth={1.5} />,
    },
    {
      label: 'Wiki',
      status: snapshot.wiki.configured ? snapshot.wiki.status : 'healthy',
      icon: <BookOpen size={12} strokeWidth={1.5} />,
    },
    {
      label: 'Queues',
      // Queues overall = worst of individual queue statuses
      status: snapshot.queues.reduce<HealthLevel>((worst, q) => {
        if (q.status === 'unhealthy') return 'unhealthy';
        if (q.status === 'degraded' && worst !== 'unhealthy') return 'degraded';
        return worst;
      }, 'healthy'),
      icon: <Server size={12} strokeWidth={1.5} />,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-[20px] p-[14px_16px] bg-bg-container border border-cloud-light mb-[20px]">
      {/* Overall status */}
      <div className="flex items-center gap-[8px] pr-[20px] border-r border-cloud-light">
        <StatusDot status={healthToDotStatus(snapshot.status)} />
        <span className="text-[13px] font-normal text-text-heading">
          System {healthLabel(snapshot.status)}
        </span>
      </div>

      {/* Per-service dots */}
      {services.map((svc) => (
        <div key={svc.label} className="flex items-center gap-[6px]">
          <StatusDot status={healthToDotStatus(svc.status)} />
          <span className="flex items-center gap-[4px] text-[12px] text-text-body-secondary font-light">
            {svc.icon}
            {svc.label}
          </span>
        </div>
      ))}

      {/* Uptime */}
      <div className="ml-auto text-[11px] text-text-body-secondary font-mono">
        up {Math.floor(snapshot.uptime_s / 3600)}h {Math.floor((snapshot.uptime_s % 3600) / 60)}m
      </div>
    </div>
  );
}

function SummaryCards({ snapshot }: { snapshot: SystemHealthSnapshot }) {
  const totalWaiting = snapshot.queues.reduce((s, q) => s + q.waiting, 0);
  const totalFailed = snapshot.queues.reduce((s, q) => s + q.failed, 0);
  const totalActive = snapshot.queues.reduce((s, q) => s + q.active, 0);

  const cards = [
    { label: 'Queued jobs', value: totalWaiting, warn: totalWaiting > 50 },
    { label: 'Active jobs', value: totalActive, warn: false },
    { label: 'Failed jobs', value: totalFailed, warn: totalFailed > 0 },
    {
      label: 'Redis memory',
      value: fmtBytes(snapshot.redis_memory.used_bytes),
      warn: snapshot.redis_memory.status !== 'healthy',
    },
    {
      label: 'LLM spend (mo.)',
      value: `$${snapshot.monthly_spend.total_usd.toFixed(2)}`,
      warn: snapshot.monthly_spend.status !== 'healthy',
    },
    {
      label: 'Non-Claude spend',
      value: `$${snapshot.monthly_spend.non_claude_usd.toFixed(2)}`,
      warn: snapshot.monthly_spend.status !== 'healthy',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-[10px] mb-[24px] sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-bg-container border border-cloud-light p-[12px_14px]"
        >
          <div className="text-[10.5px] text-text-body-secondary font-mono uppercase tracking-[0.04em] mb-[4px]">
            {card.label}
          </div>
          <div
            className={[
              'text-[20px] font-display font-light leading-none',
              card.warn ? 'text-amber-600' : 'text-text-heading',
            ].join(' ')}
          >
            {String(card.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function QueueDepthRow({ queue }: { queue: QueueStats }) {
  const depth = queue.waiting + queue.active;
  return (
    <div className="flex items-center gap-[12px] py-[8px] border-b border-cloud-light last:border-0">
      <StatusDot status={healthToDotStatus(queue.status)} />
      <span className="text-[12.5px] text-text-heading font-mono w-[180px] truncate">
        {queue.name}
      </span>
      <div className="flex-1 flex gap-[16px] text-[11.5px] text-text-body-secondary font-light">
        <span>
          <span className="font-mono text-text-heading">{queue.waiting}</span> waiting
        </span>
        <span>
          <span className="font-mono text-text-heading">{queue.active}</span> active
        </span>
        <span>
          <span
            className={['font-mono', queue.failed > 0 ? 'text-amber-600' : 'text-text-heading'].join(' ')}
          >
            {queue.failed}
          </span>{' '}
          failed
        </span>
        <span>
          <span className="font-mono text-text-heading">{queue.delayed}</span> delayed
        </span>
      </div>
      <div className="text-[11px] text-text-body-secondary font-mono">
        depth {depth}
      </div>
    </div>
  );
}

function SkillLastRunTable({ runs }: { runs: SkillLastRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="py-[24px] text-center text-[13px] text-text-body-secondary font-light">
        No skill run history yet.
      </div>
    );
  }

  return (
    <div>
      {runs.map((run) => (
        <div
          key={run.skill_name}
          className="flex items-center gap-[12px] py-[7px] border-b border-cloud-light last:border-0"
        >
          <span className="text-[12px] font-mono text-text-heading w-[200px] truncate">
            {run.skill_name}
          </span>
          <span className="text-[11.5px] text-text-body-secondary font-light flex-1 truncate">
            {run.output_summary ?? '—'}
          </span>
          <span className="shrink-0 text-[11px] text-text-body-secondary font-mono">
            {fmtDuration(run.duration_ms)}
          </span>
          <span className="shrink-0 text-[11px] text-text-body-secondary font-light">
            {fmtRelative(run.last_run_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface OverviewTabProps {
  snapshot: SystemHealthSnapshot;
}

export function OverviewTab({ snapshot }: OverviewTabProps) {
  function handleRefresh() {
    window.location.reload();
  }

  return (
    <div>
      {/* Health strip */}
      <HealthStrip snapshot={snapshot} />

      {/* Summary cards */}
      <SummaryCards snapshot={snapshot} />

      {/* Queue depth rows */}
      <section className="mb-[28px]">
        <div className="flex items-center justify-between mb-[10px]">
          <div className="text-[11px] text-text-body-secondary font-mono uppercase tracking-[0.04em]">
            Queue depths
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={11} strokeWidth={1.5} />}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        </div>
        <div className="bg-bg-container border border-cloud-light px-[14px]">
          {snapshot.queues.map((q) => (
            <QueueDepthRow key={q.name} queue={q} />
          ))}
        </div>
      </section>

      {/* Wiki health */}
      {snapshot.wiki.configured && (
        <section className="mb-[28px]">
          <div className="text-[11px] text-text-body-secondary font-mono uppercase tracking-[0.04em] mb-[10px]">
            Wiki
          </div>
          <div className="bg-bg-container border border-cloud-light p-[14px_16px] flex items-center gap-[12px]">
            <StatusDot status={healthToDotStatus(snapshot.wiki.status)} />
            <span className="text-[12.5px] text-text-heading">
              {snapshot.wiki.page_count} pages
            </span>
            {snapshot.wiki.last_commit_message && (
              <span className="text-[12px] text-text-body-secondary font-light truncate">
                {snapshot.wiki.last_commit_message}
              </span>
            )}
            {snapshot.wiki.last_commit_date && (
              <span className="ml-auto text-[11px] text-text-body-secondary font-light shrink-0">
                {fmtRelative(snapshot.wiki.last_commit_date)}
              </span>
            )}
            {snapshot.wiki.error && (
              <span className="text-[11.5px] text-red-600 font-light">
                {snapshot.wiki.error}
              </span>
            )}
          </div>
        </section>
      )}

      {/* Skill last-run table */}
      <section>
        <div className="text-[11px] text-text-body-secondary font-mono uppercase tracking-[0.04em] mb-[10px]">
          Skill last runs
        </div>
        <div className="bg-bg-container border border-cloud-light px-[14px]">
          <SkillLastRunTable runs={snapshot.skill_last_runs} />
        </div>
      </section>
    </div>
  );
}
