'use client';

/**
 * VoiceSection — Settings page voice status section.
 *
 * Read-only status display: shows Voice Capture (iOS Shortcut) integration
 * health (from configApi.integrations), total session count, and active
 * session count. (The Pipecat conversational row was removed with the
 * voice-pipecat service in #298/D143.)
 *
 * API surface:
 *   GET /api/v1/config/integrations        → { integrations: Integration[] }
 *   GET /api/v1/voice/sessions?limit=1     → { items, total, limit, offset }
 *   GET /api/v1/voice/sessions/active      → { items: VoiceSession[] }
 *
 * Patterns follow TriggersSection exemplar:
 * - TanStack Query useQuery; no mutations (read-only status section).
 * - Error UI: inline alert div with status-error CSS vars.
 * - Loading UI: skeleton pulse rows (same shape as real rows).
 * - Card wrapper with `padded={false}`; rows in divide-y container.
 * - Client component required for data fetching.
 *
 * Rows:
 * - Voice Capture (iOS Shortcut) row with active badge.
 * - Total Sessions count row.
 * - Active Sessions count row (highlighted when > 0).
 *
 * web-next adaptation:
 * - Integrations use the web-next Integration type (status: 'healthy'|'degraded'|'error'|'unknown').
 *   Status dot: 'healthy' → green, 'degraded' → warning, 'error' → red, 'unknown' → neutral.
 * - Voice stats fetched independently via voiceSessionApi (not passed as props).
 * - active() endpoint returns { items: VoiceSession[] } (not { sessions: [] }).
 */

import { Mic, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/design-system/Card';
import { StatusDot } from '@/components/design-system/StatusDot';
import { useIntegrations } from '@/lib/api/config.hooks';
import { useVoiceSessions, useActiveVoiceSessions } from '@/lib/api/voice.hooks';
import type { Integration } from '@/lib/types';

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type IntegrationStatusValue = Integration['status'];

/** Map web-next IntegrationStatus → StatusDot variant */
function integrationStatusToDot(status: IntegrationStatusValue): 'success' | 'warning' | 'error' | 'neutral' {
  switch (status) {
    case 'healthy':  return 'success';
    case 'degraded': return 'warning';
    case 'error':    return 'error';
    default:         return 'neutral';
  }
}

/** Human-readable label for an integration status value */
function integrationStatusLabel(status: IntegrationStatusValue): string {
  switch (status) {
    case 'healthy':  return 'connected';
    case 'degraded': return 'degraded';
    case 'error':    return 'error';
    default:         return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// ErrorAlert — matches TriggersSection / DangerZoneSection error pattern
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
// SkeletonRow — used during initial load (matches TriggersSection pattern)
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[14px] flex items-center justify-between gap-4">
      <div className="h-[13px] w-[180px] bg-cloud-light animate-pulse" />
      <div className="h-[13px] w-[80px] bg-cloud-light animate-pulse opacity-60" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusRow — a single key/value status row in the card
// ---------------------------------------------------------------------------

interface StatusRowProps {
  label: string;
  children: React.ReactNode;
}

function StatusRow({ label, children }: StatusRowProps) {
  return (
    <div className="px-[18px] py-[13px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <span className="text-[13px] text-text-body-secondary font-light">{label}</span>
      <div className="flex items-center gap-[6px] shrink-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActiveBadge — inline status badge
// ---------------------------------------------------------------------------

function ActiveBadge() {
  return (
    <span className="inline-flex items-center px-[6px] py-[1px] text-[10.5px] font-medium tracking-[0.02em] bg-[var(--color-status-success-bg)] border border-[var(--color-status-success-border)] text-[var(--color-status-success-fg)]">
      Active
    </span>
  );
}

// ---------------------------------------------------------------------------
// VoiceSection — main exported component
// ---------------------------------------------------------------------------

export function VoiceSection() {
  // ── Fetch integrations ─────────────────────────────────────────────────────
  const {
    data: integrationsData,
    isLoading: integrationsLoading,
    isError: integrationsError,
    error: integrationsErr,
  } = useIntegrations();

  // ── Fetch total session count (limit=1; we only need the total) ────────────
  const { data: sessionsListData, isLoading: sessionsListLoading } = useVoiceSessions({ limit: 1 });

  // ── Fetch active sessions ──────────────────────────────────────────────────
  const { data: activeData, isLoading: activeLoading } = useActiveVoiceSessions();

  const isLoading = integrationsLoading || sessionsListLoading || activeLoading;

  // ── Derive integration statuses ────────────────────────────────────────────
  const integrations = integrationsData?.integrations ?? [];
  const voiceCaptureIntegration = integrations.find(
    (i) => i.name === 'Voice Capture',
  );

  // ── Derive session stats ───────────────────────────────────────────────────
  const totalSessions = sessionsListData?.total ?? null;
  const activeSessions = activeData?.items.length ?? 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Card
      header={
        <span className="flex items-center gap-[7px]">
          <Mic size={13} strokeWidth={1.5} className="text-text-small shrink-0" />
          Voice
        </span>
      }
      description="Voice capture status — iOS Shortcut ingest → voice-capture → faster-whisper transcription."
      padded={false}
    >
      {/* ── Load error ────────────────────────────────────────────────────── */}
      {integrationsError && (
        <div className="px-[18px] py-[14px]">
          <ErrorAlert
            message={
              integrationsErr instanceof Error
                ? integrationsErr.message
                : 'Failed to load voice integration status. Try refreshing.'
            }
          />
        </div>
      )}

      {/* ── Loading skeleton ─────────────────────────────────────────────── */}
      {isLoading && !integrationsError && (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── Status rows ──────────────────────────────────────────────────── */}
      {!isLoading && !integrationsError && (
        <div className="divide-y divide-cloud-light">
          {/* Voice Capture (iOS Shortcut) */}
          <StatusRow label="Voice Capture (iOS Shortcut)">
            {voiceCaptureIntegration ? (
              <>
                <StatusDot status={integrationStatusToDot(voiceCaptureIntegration.status)} />
                <span className="text-[11.5px] text-text-body-secondary font-mono">
                  {integrationStatusLabel(voiceCaptureIntegration.status)}
                </span>
              </>
            ) : (
              <ActiveBadge />
            )}
          </StatusRow>

          {/* Total Sessions */}
          <StatusRow label="Total Sessions">
            <span className="font-mono text-[12px] text-text-body">
              {totalSessions !== null ? totalSessions.toLocaleString() : '—'}
            </span>
          </StatusRow>

          {/* Active Sessions */}
          <StatusRow label="Active Sessions">
            <span
              className={[
                'font-mono text-[12px]',
                activeSessions > 0
                  ? 'text-[var(--color-book-cloth)]'
                  : 'text-text-body',
              ].join(' ')}
            >
              {activeSessions}
            </span>
          </StatusRow>
        </div>
      )}
    </Card>
  );
}
