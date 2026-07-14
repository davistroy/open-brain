import type { DashboardStats } from '@/lib/types';

interface StatBlockProps {
  label: string;
  value: string | number;
  delta?: string;
  deltaTone?: 'success' | 'error';
  meta?: string;
}

function StatBlock({ label, value, delta, deltaTone = 'success', meta }: StatBlockProps) {
  return (
    <div className="flex-1 min-w-0 px-[18px] py-[16px] border-r border-cloud-light last:border-r-0">
      <div className="font-mono text-[10.5px] font-normal tracking-[0.08em] uppercase text-text-body-secondary mb-[10px]">
        {label}
      </div>
      <div className="flex items-baseline gap-[10px]">
        <div
          className="font-display text-[34px] font-light tracking-[-0.03em] leading-none text-text-heading"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {value}
        </div>
        {delta && (
          <span
            className="font-mono text-[11px] tracking-[0.02em]"
            style={{ color: deltaTone === 'success' ? 'var(--color-success)' : 'var(--color-faded-red)' }}
          >
            {delta}
          </span>
        )}
      </div>
      {meta && (
        <div className="text-[12px] text-text-body-secondary mt-[8px] font-light">
          {meta}
        </div>
      )}
    </div>
  );
}

interface StatStripProps {
  stats: DashboardStats;
}

/**
 * Horizontal strip of stat blocks across the dashboard top.
 * Mirrors 01-dashboard.html StatStrip — 5 blocks with 1px right border separators.
 * Server component.
 */
export function StatStrip({ stats }: StatStripProps) {
  return (
    <div className="flex bg-bg-container border border-cloud-light mb-[20px]">
      <StatBlock
        label="Captures / 7d"
        value={stats.captures_7d}
        delta={stats.captures_7d_delta}
        deltaTone={stats.captures_7d_delta.startsWith('▲') ? 'success' : 'error'}
        meta={stats.captures_7d_meta}
      />
      <StatBlock
        label="Active entities"
        value={stats.active_entities}
        delta={stats.active_entities_delta}
        deltaTone={stats.active_entities_delta.startsWith('▲') ? 'success' : 'error'}
        meta={stats.active_entities_meta}
      />
      <StatBlock
        label="Open questions"
        value={stats.open_questions}
        delta={stats.open_questions_delta}
        deltaTone={stats.open_questions_delta.startsWith('▲') ? 'success' : 'error'}
        meta={stats.open_questions_meta}
      />
      <StatBlock
        label="Briefs in progress"
        value={stats.briefs_in_progress}
        meta={stats.briefs_due_meta}
      />

      {/* Pipeline block — custom layout, no delta */}
      <div className="px-[18px] py-[16px] min-w-[160px]">
        <div className="font-mono text-[10.5px] font-normal tracking-[0.08em] uppercase text-text-body-secondary mb-[10px]">
          Pipeline
        </div>
        <div className="flex items-center gap-[8px]">
          <span
            className="inline-block w-[8px] h-[8px] shrink-0"
            style={{ background: stats.pipeline_status === 'healthy' ? 'var(--color-success)' : 'var(--color-faded-red)' }}
          />
          <span className="text-[13.5px] text-text-heading capitalize">
            {stats.pipeline_status}
          </span>
        </div>
        <div className="font-mono text-[12px] text-text-body-secondary mt-[8px] font-light tracking-[0.03em]">
          {stats.pipeline_active} active · {stats.pipeline_queued} queued
        </div>
        {stats.pipeline_failed > 0 && (
          <div
            className="font-mono text-[12px] mt-[4px] font-light tracking-[0.03em]"
            style={{ color: 'var(--color-faded-red)' }}
          >
            {stats.pipeline_failed} failed
          </div>
        )}
      </div>
    </div>
  );
}
