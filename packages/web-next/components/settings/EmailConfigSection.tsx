'use client';

/**
 * EmailConfigSection — Settings page email configuration status display.
 *
 * Shows the health status of the two email integration channels:
 *   - Email (Inbound)  — Cloudflare Email Worker → core-api captures
 *   - Email (Outbound) — brain-outbound SMTP / email-compose skill
 *
 * This section is DISTINCT from EmailAllowlistSection, which manages
 * the `email_allowlist` app_setting (sender CRUD). EmailConfigSection
 * shows the health/connectivity of the integration channels themselves.
 *
 * API surface:
 *   GET /api/v1/config/integrations → { integrations: Integration[] }
 *   Filtered client-side to name === 'Email (Inbound)' and 'Email (Outbound)'.
 *
 * Patterns follow the TriggersSection exemplar:
 * - TanStack Query useQuery; no mutations (read-only status display).
 * - Skeleton pulse rows during initial load.
 * - ErrorAlert (inline, CSS vars, no Flashbar / toast).
 * - Card with padded={false}; status rows in divide-y container.
 * - Client component required for interactivity / data fetching.
 */

import { Send, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/design-system/Card';
import { StatusDot } from '@/components/design-system/StatusDot';
import { useEmailConfig } from '@/lib/api/email-settings.hooks';
import type { EmailConfig } from '@/lib/types';

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
// Skeleton row — mirrors real row shape during initial load
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[14px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <div className="flex flex-col gap-[6px] flex-1 min-w-0">
        <div className="h-[13px] w-[100px] bg-cloud-light animate-pulse" />
        <div className="h-[11px] w-[200px] bg-cloud-light animate-pulse opacity-60" />
      </div>
      <div className="flex items-center gap-2">
        <div className="h-[10px] w-[10px] rounded-full bg-cloud-light animate-pulse" />
        <div className="h-[11px] w-[60px] bg-cloud-light animate-pulse opacity-60" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusDot mapping helpers
// ---------------------------------------------------------------------------

function channelStatusToDot(
  status: EmailConfig['inbound']['status'] | EmailConfig['outbound']['status'],
): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'connected') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'error') return 'error';
  return 'neutral';
}

function channelStatusLabel(
  status: EmailConfig['inbound']['status'] | EmailConfig['outbound']['status'],
): string {
  if (status === 'connected') return 'Connected';
  if (status === 'degraded') return 'Degraded';
  if (status === 'error') return 'Error';
  return 'Not configured';
}

// ---------------------------------------------------------------------------
// EmailChannelRow — single inbound or outbound channel row
// ---------------------------------------------------------------------------

interface EmailChannelRowProps {
  label: string;
  channel: EmailConfig['inbound'] | EmailConfig['outbound'];
}

function EmailChannelRow({ label, channel }: EmailChannelRowProps) {
  const dotStatus = channelStatusToDot(channel.status);
  const dotLabel = channelStatusLabel(channel.status);

  return (
    <div className="px-[18px] py-[13px] flex items-start justify-between gap-4 border-b border-cloud-light last:border-b-0">
      {/* Label + detail */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-heading leading-[18px]">
          {label}
        </div>
        {channel.detail && (
          <p className="text-[11.5px] text-text-body-secondary font-light truncate leading-[16px] mt-[1px]">
            {channel.detail}
          </p>
        )}
      </div>

      {/* Health dot + label */}
      <StatusDot status={dotStatus} label={dotLabel} className="shrink-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmailConfigSection — main exported component
// ---------------------------------------------------------------------------

export function EmailConfigSection() {
  const { data, isLoading, isError, error } = useEmailConfig();

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Card
      header="Email configuration"
      description="Health status of the email inbound (Cloudflare Email Worker) and outbound (SMTP / email-compose) channels."
      padded={false}
      actions={
        <Send
          size={14}
          strokeWidth={1.5}
          className="text-text-small shrink-0"
          aria-hidden
        />
      }
    >
      {/* ── Load error ──────────────────────────────────────────────── */}
      {isError && (
        <div className="px-[18px] py-[14px]">
          <ErrorAlert
            message={
              error instanceof Error
                ? error.message
                : 'Failed to load email configuration. Try refreshing.'
            }
          />
        </div>
      )}

      {/* ── Loading skeleton ────────────────────────────────────────── */}
      {isLoading && !isError && (
        <>
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── Channel rows ────────────────────────────────────────────── */}
      {!isLoading && !isError && data && (
        <div className="divide-y divide-cloud-light">
          <EmailChannelRow label="Inbound" channel={data.inbound} />
          <EmailChannelRow label="Outbound" channel={data.outbound} />
        </div>
      )}
    </Card>
  );
}
