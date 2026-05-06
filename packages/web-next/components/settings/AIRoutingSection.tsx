'use client';

/**
 * AIRoutingSection — Settings page AI model routing table + budget meter.
 *
 * Read-only section that shows:
 *   - Task-to-model routing table with client badge and monthly call count.
 *   - Monthly LLM spend progress bar (month_total_usd vs hard_limit_usd).
 *   - Soft/hard budget limit labels.
 *
 * API surface (matches packages/core-api/src/routes/config.ts):
 *   GET /api/v1/config/ai-routing  → AIRoutingConfig
 *
 * Patterns (exemplar: TriggersSection.tsx):
 * - Data via TanStack Query useQuery; no mutations (read-only).
 * - Error UI: inline ErrorAlert with status-error CSS vars.
 * - Loading UI: skeleton pulse rows (same shape as real rows).
 * - Card wrapper with padded={false}.
 * - Client component required (interactivity: query re-fetch button).
 *
 * UX parity with packages/web/src/components/settings/AIRoutingSection.tsx:
 * - Same model routing table columns: Task, Model, Client, Calls.
 * - Same budget progress bar with colour threshold logic (>80% red, >60% amber).
 * - Same soft/hard limit labels below progress bar.
 * - Client badge: anthropic = accent pill, others = neutral pill.
 */

import { useQuery } from '@tanstack/react-query';
import { TriangleAlert, RefreshCw } from 'lucide-react';
import { Card, Pill } from '@/components/design-system';
import { aiRoutingApi } from '@/lib/api-client';
import type { AIRoutingConfig, ModelRoutingEntry } from '@/lib/types';

// ---------------------------------------------------------------------------
// Query key
// ---------------------------------------------------------------------------

const AI_ROUTING_QUERY_KEY = ['ai-routing'] as const;

// ---------------------------------------------------------------------------
// Inline error alert — matches TriggersSection / DangerZoneSection pattern
// ---------------------------------------------------------------------------

function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-3 px-4 py-3 border border-[var(--color-status-error-border)] bg-[var(--color-status-error-bg)]"
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
// Skeleton row — used during initial load (matches routing table row shape)
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[11px] grid grid-cols-[1fr_1.5fr_auto_auto] gap-x-4 items-center border-b border-cloud-light last:border-b-0">
      <div className="h-[12px] w-[80px] bg-cloud-light animate-pulse" />
      <div className="h-[12px] w-[140px] bg-cloud-light animate-pulse opacity-70" />
      <div className="h-[20px] w-[56px] bg-cloud-light animate-pulse" />
      <div className="h-[12px] w-[36px] bg-cloud-light animate-pulse justify-self-end" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelRow — single row in the routing table
// ---------------------------------------------------------------------------

interface ModelRowProps {
  entry: ModelRoutingEntry;
}

function ModelRow({ entry }: ModelRowProps) {
  const isAnthropic = entry.client === 'anthropic';

  return (
    <div className="px-[18px] py-[10px] grid grid-cols-[1fr_1.5fr_auto_auto] gap-x-4 items-center border-b border-cloud-light last:border-b-0">
      {/* Task */}
      <span className="text-[12.5px] font-medium text-text-heading capitalize truncate">
        {entry.task}
      </span>

      {/* Model */}
      <span className="text-[11.5px] font-mono text-text-body-secondary truncate">
        {entry.model}
      </span>

      {/* Client badge */}
      <Pill
        tone={isAnthropic ? 'accent' : 'neutral'}
        size="xs"
      >
        {entry.client}
      </Pill>

      {/* Monthly calls */}
      <span className="text-[11px] text-text-small font-mono tabular-nums text-right">
        {entry.month_calls > 0 ? entry.month_calls.toLocaleString() : '—'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ColumnHeader — table header row
// ---------------------------------------------------------------------------

function ColumnHeader() {
  return (
    <div className="px-[18px] py-[8px] grid grid-cols-[1fr_1.5fr_auto_auto] gap-x-4 items-center border-b border-cloud-light bg-[var(--color-ivory-medium)]">
      <span className="text-[10.5px] font-medium tracking-[0.04em] text-text-small uppercase">Task</span>
      <span className="text-[10.5px] font-medium tracking-[0.04em] text-text-small uppercase">Model</span>
      <span className="text-[10.5px] font-medium tracking-[0.04em] text-text-small uppercase">Client</span>
      <span className="text-[10.5px] font-medium tracking-[0.04em] text-text-small uppercase text-right">Calls</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BudgetMeter — monthly spend progress bar + labels
// ---------------------------------------------------------------------------

interface BudgetMeterProps {
  budget: AIRoutingConfig['budget'];
}

function BudgetMeter({ budget }: BudgetMeterProps) {
  const pct =
    budget.hard_limit_usd > 0
      ? Math.min(100, (budget.month_total_usd / budget.hard_limit_usd) * 100)
      : 0;

  // Colour thresholds matching the web original
  const barColor =
    pct > 80
      ? 'bg-[var(--color-status-error-fg)]'
      : pct > 60
        ? 'bg-[var(--color-status-warning-fg)]'
        : 'bg-[var(--color-status-success-fg)]';

  return (
    <div className="px-[18px] py-[14px] border-t border-cloud-light">
      {/* Spend row */}
      <div className="flex items-center justify-between mb-[8px]">
        <span className="text-[12px] text-text-body-secondary font-light">Monthly spend</span>
        <span className="font-mono text-[11.5px] text-text-heading">
          ${budget.month_total_usd.toFixed(2)}{' '}
          <span className="text-text-small font-light">/ ${budget.hard_limit_usd.toFixed(0)} budget</span>
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-[3px] bg-cloud-dark rounded-none overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Limit labels */}
      <div className="flex items-center justify-between mt-[6px]">
        <span className="text-[10.5px] text-text-small font-mono">
          Soft: ${budget.soft_limit_usd}
        </span>
        <span className="text-[10.5px] text-text-small font-mono">
          Hard: ${budget.hard_limit_usd}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AIRoutingSection — main exported component
// ---------------------------------------------------------------------------

export function AIRoutingSection() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<AIRoutingConfig>({
    queryKey: AI_ROUTING_QUERY_KEY,
    queryFn: () => aiRoutingApi.get(),
    staleTime: 60_000,   // routing config rarely changes; re-fetch after 60s
  });

  const models = data?.models ?? [];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Card
      header="AI routing"
      description="Model routing table for all AI tasks, plus monthly LLM budget meter."
      padded={false}
      actions={
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          aria-label="Refresh AI routing data"
          className={[
            'p-[4px] text-text-small rounded-none',
            'hover:text-text-heading hover:bg-cloud-light',
            'transition-colors duration-[120ms]',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          <RefreshCw
            size={13}
            strokeWidth={1.5}
            className={isFetching ? 'animate-spin' : ''}
          />
        </button>
      }
    >
      {/* ── Load error ──────────────────────────────────────────────────── */}
      {isError && (
        <div className="px-[18px] py-[14px]">
          <ErrorAlert
            message={
              error instanceof Error
                ? error.message
                : 'Failed to load AI routing config. Try refreshing.'
            }
          />
        </div>
      )}

      {/* ── Loading skeleton ─────────────────────────────────────────────── */}
      {isLoading && !isError && (
        <>
          <ColumnHeader />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── Model routing table ──────────────────────────────────────────── */}
      {!isLoading && !isError && models.length > 0 && (
        <>
          <ColumnHeader />
          <div>
            {models.map((entry) => (
              <ModelRow key={entry.task} entry={entry} />
            ))}
          </div>
        </>
      )}

      {/* ── Empty state ──────────────────────────────────────────────────── */}
      {!isLoading && !isError && models.length === 0 && (
        <div className="px-[18px] py-[32px] text-center border-t border-cloud-light">
          <p className="text-[13px] text-text-body-secondary font-light">
            No model routing entries configured.
          </p>
        </div>
      )}

      {/* ── Budget meter ─────────────────────────────────────────────────── */}
      {!isLoading && !isError && data?.budget && (
        <BudgetMeter budget={data.budget} />
      )}
    </Card>
  );
}
