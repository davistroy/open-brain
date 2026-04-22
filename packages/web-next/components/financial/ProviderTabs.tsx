'use client';

/**
 * ProviderTabs — client component for the Financial page.
 *
 * Renders a tab bar (one tab per financial provider) and a capture list
 * for the active tab. Tab state is local (useState) — no URL push because
 * financial providers are display-only; deep-linking to a specific provider
 * is not a use case here.
 *
 * Each capture card shows:
 *   - Content preview (first 120 chars)
 *   - Client-side amount estimation from source_metadata (best-effort)
 *   - Source badge (always 'api' or 'document' for financial captures)
 *   - Relative timestamp
 *
 * Receives pre-fetched provider→captures map from the RSC page so no
 * additional API calls are made client-side.
 */

import { useState } from 'react';
import { DollarSign, Inbox } from 'lucide-react';
import { EmptyState } from '@/components/design-system/EmptyState';
import type { Capture } from '@/lib/types';
import type { ProviderId } from '@/app/(shell)/financial/page';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Provider {
  id: ProviderId;
  label: string;
}

interface ProviderTabsProps {
  providers: readonly Provider[];
  capturesByProvider: Record<ProviderId, Capture[]>;
}

// ---------------------------------------------------------------------------
// Amount estimation
//
// Financial pipeline stores transaction data in source_metadata. We attempt
// to extract a display amount from common field patterns. All logic is
// best-effort — no error thrown on unexpected shape.
// ---------------------------------------------------------------------------

function estimateAmount(capture: Capture): string | null {
  // source_metadata is not typed on Capture (it's opaque JSONB from the API).
  // Cast safely.
  const meta = (capture as unknown as { source_metadata?: Record<string, unknown> })
    .source_metadata;
  if (!meta || typeof meta !== 'object') return null;

  // Common field names across financial pipeline sources
  const raw =
    meta['amount'] ??
    meta['transaction_amount'] ??
    meta['balance'] ??
    meta['total'] ??
    null;

  if (raw === null || raw === undefined) return null;

  const num = parseFloat(String(raw));
  if (isNaN(num)) return null;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(num);
}

// ---------------------------------------------------------------------------
// Relative time formatter
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// CaptureCard — single capture row in the financial list
// ---------------------------------------------------------------------------

function CaptureCard({ capture }: { capture: Capture }) {
  const amount = estimateAmount(capture);
  const preview = capture.content.length > 120
    ? `${capture.content.slice(0, 120).trimEnd()}…`
    : capture.content;

  return (
    <div className="bg-bg-container border border-cloud-light p-4 flex items-start gap-4">
      {/* Amount / icon column */}
      <div className="shrink-0 w-[72px] text-right">
        {amount ? (
          <span className="font-mono text-[13px] text-text-heading font-normal">
            {amount}
          </span>
        ) : (
          <DollarSign
            size={14}
            strokeWidth={1.3}
            className="text-cloud-dark inline-block"
          />
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 space-y-[4px]">
        <p className="text-[13px] text-text-body leading-[1.5] font-light m-0">
          {preview}
        </p>

        {/* Meta row */}
        <div className="flex items-center gap-[8px]">
          {/* Capture type badge */}
          <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary">
            {capture.capture_type}
          </span>
          <span className="text-cloud-dark opacity-40 text-[10px]">·</span>
          {/* Relative time */}
          <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary">
            {formatRelative(capture.created_at)}
          </span>
          {/* Pipeline status indicator — only show non-complete states */}
          {capture.pipeline_status !== 'complete' && (
            <>
              <span className="text-cloud-dark opacity-40 text-[10px]">·</span>
              <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary opacity-70">
                {capture.pipeline_status}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderTabs
// ---------------------------------------------------------------------------

export function ProviderTabs({ providers, capturesByProvider }: ProviderTabsProps) {
  const [activeId, setActiveId] = useState<ProviderId>(providers[0].id);

  const activeCaptures = capturesByProvider[activeId] ?? [];

  return (
    <div>
      {/* Tab bar */}
      <div
        className="flex border-b border-cloud-light mb-[18px]"
        role="tablist"
      >
        {providers.map((provider) => {
          const isActive = provider.id === activeId;
          const count = capturesByProvider[provider.id]?.length ?? 0;

          return (
            <button
              key={provider.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${provider.id}`}
              onClick={() => setActiveId(provider.id)}
              className={[
                'inline-flex items-center gap-[8px]',
                'px-[18px] py-[10px]',
                'font-body text-[13px] tracking-[0.005em]',
                'border-none bg-transparent cursor-pointer',
                'border-b-2 -mb-px',
                'transition-colors duration-[120ms]',
                isActive
                  ? 'border-book-cloth text-text-heading font-normal'
                  : 'border-transparent text-text-body-secondary font-light hover:text-text-body',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {provider.label}
              <span className="font-mono text-[10.5px] text-text-body-secondary font-normal">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab panel */}
      <div
        id={`tabpanel-${activeId}`}
        role="tabpanel"
        aria-label={providers.find((p) => p.id === activeId)?.label ?? activeId}
      >
        {activeCaptures.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={`No captures for ${providers.find((p) => p.id === activeId)?.label ?? activeId}`}
            description="Financial captures appear here once the pipeline processes data from this provider."
          />
        ) : (
          <div className="space-y-[6px]">
            {activeCaptures.map((capture) => (
              <CaptureCard key={capture.id} capture={capture} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
