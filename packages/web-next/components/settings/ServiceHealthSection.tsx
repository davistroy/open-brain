'use client';

/**
 * ServiceHealthSection — Settings page read-only service health view.
 *
 * Renders the three core dependency checks (Postgres, Redis, LLM) returned by
 * GET /api/v1/health. Purely informational — no mutations.
 *
 * API surface (matches packages/core-api/src/routes/health.ts):
 *   GET /api/v1/health → HealthResponse
 *     { status, timestamp, version?, uptime_s?, services: { postgres, redis, llm } }
 *   Each service: { status: 'healthy'|'degraded'|'unhealthy', latency_ms?, error? }
 *
 * Design notes (port-IA context):
 * - Service health appears in BOTH the System page (overview tab health strip,
 *   server-rendered) AND here in Settings (client-rendered, on demand). The System
 *   page uses systemHealthApi.snapshot() which covers queues/redis memory/spend.
 *   This section uses the lighter /api/v1/health endpoint (3 dependency checks
 *   with latency) — intentional divergence; the two views serve different purposes.
 * - Read-only subset pattern: useQuery + loading skeleton + error UI + row list.
 *   No mutations. Optional manual refresh via query.refetch().
 * - StatusDot tokens: success (healthy) / warning (degraded) / error (unhealthy).
 *
 * UX parity with packages/web/src/components/settings/ServiceHealthSection.tsx:
 * - Same per-service rows: name, status dot, latency_ms if present.
 * - Same three services: postgres, redis, llm (the API hardcodes these).
 * - Adds: overall status badge in Card description (not in the web original).
 * - Drops: models_available display (web original showed it; /api/v1/health does
 *   not return this field — it was a UI artefact pointing at a stale shape).
 */

import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Card, StatusDot, Button } from '@/components/design-system';
import { useServiceHealth } from '@/lib/api/service-health.hooks';
import type { ServiceHealthStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type HealthLevel = ServiceHealthStatus;

function toStatusDot(level: HealthLevel): 'success' | 'warning' | 'error' {
  if (level === 'healthy') return 'success';
  if (level === 'degraded') return 'warning';
  return 'error';
}

function healthLabel(level: HealthLevel): string {
  if (level === 'healthy') return 'Healthy';
  if (level === 'degraded') return 'Degraded';
  return 'Unhealthy';
}

/** Display name for each service key returned by the API. */
function serviceName(key: string): string {
  if (key === 'llm') return 'LLM provider';
  if (key === 'postgres') return 'PostgreSQL';
  if (key === 'redis') return 'Redis';
  // Capitalise unknown keys gracefully
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// ---------------------------------------------------------------------------
// ErrorAlert — matches TriggersSection / DangerZoneSection pattern
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
// SkeletonRow — same shape as ServiceRow for no-jank loading
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[13px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <div className="flex items-center gap-[10px]">
        <div className="w-[6px] h-[6px] bg-cloud-light animate-pulse shrink-0" />
        <div className="h-[13px] w-[100px] bg-cloud-light animate-pulse" />
      </div>
      <div className="h-[11px] w-[48px] bg-cloud-light animate-pulse opacity-60" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServiceRow — one dependency row
// ---------------------------------------------------------------------------

interface ServiceEntry {
  status: HealthLevel;
  latency_ms?: number;
  error?: string;
}

interface ServiceRowProps {
  name: string;
  entry: ServiceEntry;
}

function ServiceRow({ name, entry }: ServiceRowProps) {
  return (
    <div className="px-[18px] py-[13px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      {/* Left: dot + name */}
      <div className="flex items-center gap-[10px]">
        <StatusDot status={toStatusDot(entry.status)} />
        <span className="text-[13px] font-medium text-text-heading">{name}</span>
        {entry.error && (
          <span className="text-[11.5px] text-[var(--color-status-error-fg)] font-light truncate max-w-[240px]">
            {entry.error}
          </span>
        )}
      </div>

      {/* Right: status label + optional latency */}
      <div className="flex items-center gap-[12px] shrink-0">
        {entry.latency_ms !== undefined && (
          <span className="text-[11.5px] text-text-body-secondary font-mono">
            {entry.latency_ms}ms
          </span>
        )}
        <span
          className={[
            'text-[11.5px] font-medium',
            entry.status === 'healthy'
              ? 'text-[var(--color-success)]'
              : entry.status === 'degraded'
                ? 'text-[var(--color-status-warning-fg)]'
                : 'text-[var(--color-status-error-fg)]',
          ].join(' ')}
        >
          {healthLabel(entry.status)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServiceHealthSection — main exported component
// ---------------------------------------------------------------------------

export function ServiceHealthSection() {
  const query = useServiceHealth();

  const data = query.data;
  const isLoading = query.isLoading;
  const isError = query.isError;

  // Build the service entries list when data is available
  const serviceEntries: Array<{ key: string; entry: ServiceEntry }> = data
    ? Object.entries(data.services).map(([key, svc]) => ({
        key,
        entry: svc as ServiceEntry,
      }))
    : [];

  // Card description slot: overall status chip when loaded
  const overallStatus = data?.status ?? null;

  return (
    <Card
      header="Service health"
      description={
        overallStatus ? (
          <span className="flex items-center gap-[6px]">
            <StatusDot status={toStatusDot(overallStatus)} />
            <span>System {healthLabel(overallStatus)}</span>
            {data?.uptime_s !== undefined && (
              <span className="text-text-small font-light">
                &middot; up {Math.floor(data.uptime_s / 3600)}h{' '}
                {Math.floor((data.uptime_s % 3600) / 60)}m
              </span>
            )}
          </span>
        ) : (
          'Core dependency health: PostgreSQL, Redis, and LLM provider.'
        )
      }
      padded={false}
      actions={
        <Button
          variant="ghost"
          size="sm"
          icon={
            query.isFetching ? (
              <RefreshCw size={11} strokeWidth={1.5} className="animate-spin" />
            ) : (
              <RefreshCw size={11} strokeWidth={1.5} />
            )
          }
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          aria-label="Refresh service health"
        >
          Refresh
        </Button>
      }
    >
      {/* ── Load error ─────────────────────────────────────────────────── */}
      {isError && (
        <div className="px-[18px] py-[14px]">
          <ErrorAlert
            message={
              query.error instanceof Error
                ? query.error.message
                : 'Failed to load service health. Try refreshing.'
            }
          />
        </div>
      )}

      {/* ── Loading skeleton ───────────────────────────────────────────── */}
      {isLoading && !isError && (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── Empty state (loaded but no services — shouldn't happen) ─────── */}
      {!isLoading && !isError && serviceEntries.length === 0 && (
        <div className="px-[18px] py-[32px] text-center border-t border-cloud-light">
          <p className="text-[13px] text-text-body-secondary font-light">
            No service data available.
          </p>
        </div>
      )}

      {/* ── Service rows ───────────────────────────────────────────────── */}
      {!isLoading && !isError && serviceEntries.length > 0 && (
        <div className="divide-y divide-cloud-light">
          {serviceEntries.map(({ key, entry }) => (
            <ServiceRow
              key={key}
              name={serviceName(key)}
              entry={entry}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
