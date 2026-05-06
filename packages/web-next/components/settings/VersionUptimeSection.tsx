'use client';

/**
 * VersionUptimeSection — Settings page read-only version + uptime display.
 *
 * Fetches GET /api/v1/health which returns { version, uptime_s, status, ... }.
 * This is the same endpoint the web (Vite) Settings page uses.
 *
 * Note: /api/v1/system/health (systemHealthApi.snapshot) also exposes uptime_s
 * but NOT version — that endpoint is for the richer System page. /api/v1/health
 * is the canonical lightweight version+uptime surface.
 *
 * UX parity with packages/web/src/components/settings/VersionUptimeSection.tsx:
 * - Same two fields: Version (mono) and Uptime (humanized).
 * - Same uptime format: Xh Ym (inline, no "days" level — matches web formatUptime).
 * - Same loading skeleton (2 pulse rows) + inline error alert.
 * - Read-only: no mutations, no actions slot.
 *
 * Pattern: read-only status subset — GET + loading + error + display only.
 * Follows TriggersSection exemplar for Card wrapper, skeleton, error alert,
 * and TanStack Query useQuery.
 */

import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Card } from '@/components/design-system/Card';
import { request } from '@/lib/api-client';
import type { HealthResponse } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Query key
// ---------------------------------------------------------------------------

const VERSION_UPTIME_QUERY_KEY = ['settings', 'version-uptime'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Humanize uptime seconds → "5d 12h 34m" (with days when >= 1 day),
 * or "3h 22m", or "45m", or "—" when undefined/zero.
 *
 * Extends the web original (formatUptime in packages/web/src/components/settings/utils.ts)
 * to include days — the web version omits days, which works for fresh restarts but
 * looks odd after a multi-day uptime. The Settings view benefits from the extra precision.
 */
function formatUptime(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------
// Sub-components
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

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[14px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <div className="h-[13px] w-[80px] bg-cloud-light animate-pulse" />
      <div className="h-[13px] w-[120px] bg-cloud-light animate-pulse" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DataRow — a single key/value display row
// ---------------------------------------------------------------------------

function DataRow({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={[
        'px-[18px] py-[13px] flex items-center justify-between gap-4',
        !last ? 'border-b border-cloud-light' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="text-[13px] text-text-body-secondary font-light">{label}</span>
      <span
        className={[
          'text-[13px] text-text-heading',
          mono ? 'font-mono' : 'font-normal',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VersionUptimeSection — main exported component
// ---------------------------------------------------------------------------

export function VersionUptimeSection() {
  const { data, isLoading, isError, error } = useQuery<HealthResponse>({
    queryKey: VERSION_UPTIME_QUERY_KEY,
    queryFn: () => request<HealthResponse>('/health'),
    staleTime: 30_000,
    // Re-fetch every 60s so uptime stays reasonably current without hammering the API.
    refetchInterval: 60_000,
  });

  return (
    <Card
      header="Version & Uptime"
      description="Current build version and time since last process restart."
      padded={false}
    >
      {/* ── Load error ──────────────────────────────────────────────────── */}
      {isError && (
        <div className="px-[18px] py-[14px]">
          <ErrorAlert
            message={
              error instanceof Error
                ? error.message
                : 'Failed to load version info. Try refreshing.'
            }
          />
        </div>
      )}

      {/* ── Loading skeleton ─────────────────────────────────────────────── */}
      {isLoading && !isError && (
        <>
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── Data rows ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && data !== undefined && (
        <>
          <DataRow
            label="Version"
            value={data.version ?? '—'}
            mono
          />
          <DataRow
            label="Uptime"
            value={formatUptime(data.uptime_s)}
            last
          />
        </>
      )}
    </Card>
  );
}
