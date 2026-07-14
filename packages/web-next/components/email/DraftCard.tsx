'use client';

/**
 * DraftCard — single email draft row in the Drafts tab.
 *
 * Visual anatomy:
 *   [status stripe — left 3px border]
 *   [To: address]                [send_mode badge]   [date]
 *   [Subject]
 *   [Body preview — 2 lines]
 *   [Send button]  [Reject button]
 *
 * Actions:
 *   Send   — calls onSend(id), requires inline confirmation ("Click again to confirm")
 *   Reject — calls onReject(id), same two-tap confirmation pattern
 *
 * No modal — confirmation is inline state (first click arms it, second fires).
 * This avoids importing Radix Dialog for a simple destructive confirm.
 *
 * Parent (EmailTabs / DraftsPanel) supplies callbacks wired to useMutation.
 */

import { useState } from 'react';
import { Send, Trash2, Clock, Mail } from 'lucide-react';
import { useClientNow } from '@/hooks/useClientNow';
import type { EmailDraft, EmailDraftStatus } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string, now: number | null): string {
  const date = new Date(iso);
  // Pre-mount (SSR + first client render): stable absolute date, no `now` dependency.
  if (now === null) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const diffMs = now - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / 3_600_000);
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / 60_000);
      return diffMins <= 1 ? 'Just now' : `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const STATUS_LABELS: Record<EmailDraftStatus, string> = {
  draft:    'Draft',
  approved: 'Approved',
  sent:     'Sent',
  rejected: 'Rejected',
  failed:   'Failed',
};

/** Left border color by status — echoes Cloudscape status semantics. */
function statusStripeClass(status: EmailDraftStatus): string {
  switch (status) {
    case 'draft':    return 'border-l-cloud-dark';
    case 'approved': return 'border-l-book-cloth';
    case 'sent':     return 'border-l-success';
    case 'rejected': return 'border-l-cloud-light';
    case 'failed':   return 'border-l-faded-red';
    default:         return 'border-l-cloud-light';
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DraftCardProps {
  draft: EmailDraft;
  onSend: (id: string) => void;
  onReject: (id: string) => void;
  isSending?: boolean;
  isRejecting?: boolean;
}

// ---------------------------------------------------------------------------
// DraftCard
// ---------------------------------------------------------------------------

export function DraftCard({
  draft,
  onSend,
  onReject,
  isSending = false,
  isRejecting = false,
}: DraftCardProps) {
  const { id, to_address, cc_address, subject, body, status, send_mode, created_at } = draft;
  const now = useClientNow();

  // Two-tap inline confirmation state
  const [sendArmed, setSendArmed] = useState(false);
  const [rejectArmed, setRejectArmed] = useState(false);

  // Preview: first 200 chars of body, trimmed
  const bodyPreview = body.length > 200 ? `${body.slice(0, 200).trimEnd()}…` : body;

  const isActionable = status === 'draft' || status === 'approved';
  const isProcessing = isSending || isRejecting;

  function handleSendClick() {
    if (!sendArmed) {
      setSendArmed(true);
      setRejectArmed(false);
      // Auto-disarm after 4 seconds
      setTimeout(() => setSendArmed(false), 4_000);
      return;
    }
    setSendArmed(false);
    onSend(id);
  }

  function handleRejectClick() {
    if (!rejectArmed) {
      setRejectArmed(true);
      setSendArmed(false);
      setTimeout(() => setRejectArmed(false), 4_000);
      return;
    }
    setRejectArmed(false);
    onReject(id);
  }

  return (
    <div
      className={[
        'bg-bg-container border border-cloud-light rounded-none',
        'border-l-4',
        statusStripeClass(status),
        'p-4 space-y-3',
        // Dim non-actionable drafts
        status === 'rejected' || status === 'sent' ? 'opacity-60' : '',
      ].filter(Boolean).join(' ')}
    >
      {/* Header row: To + status badge + date */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[6px]">
            <Mail
              size={12}
              strokeWidth={1.5}
              className="text-text-body-secondary shrink-0"
            />
            <span className="font-mono text-[11.5px] tracking-[0.04em] text-text-body-secondary truncate">
              {to_address}
            </span>
            {cc_address && (
              <span className="font-mono text-[10.5px] tracking-[0.03em] text-text-small truncate">
                cc: {cc_address}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-[8px] shrink-0">
          {/* Send mode badge */}
          {send_mode === 'auto-send' && (
            <span className="font-mono text-[9.5px] tracking-[0.06em] uppercase px-[6px] py-[2px] border border-book-cloth text-book-cloth">
              Auto-send
            </span>
          )}

          {/* Status badge */}
          <span className="font-mono text-[9.5px] tracking-[0.06em] uppercase text-text-body-secondary">
            {STATUS_LABELS[status]}
          </span>

          {/* Relative date */}
          <span className="inline-flex items-center gap-[3px] font-mono text-[10px] tracking-[0.04em] text-text-small">
            <Clock size={9} strokeWidth={1.5} />
            {formatRelative(created_at, now)}
          </span>
        </div>
      </div>

      {/* Subject */}
      <div className="text-[13.5px] font-normal text-text-heading leading-[1.4] tracking-[-0.005em]">
        {subject}
      </div>

      {/* Body preview */}
      <p className="text-[12.5px] font-light text-text-body leading-[1.55] m-0">
        {bodyPreview}
      </p>

      {/* Actions — only for actionable drafts */}
      {isActionable && (
        <div className="flex items-center gap-[10px] pt-1 border-t border-cloud-light">
          {/* Send button — two-tap confirm */}
          <button
            type="button"
            disabled={isProcessing}
            onClick={handleSendClick}
            className={[
              'inline-flex items-center gap-[5px]',
              'text-[11px] font-mono tracking-[0.04em] uppercase',
              'transition-colors duration-fast cursor-pointer',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              sendArmed
                ? 'text-book-cloth font-medium'
                : 'text-text-body-secondary hover:text-text-heading',
            ].join(' ')}
          >
            <Send size={10} strokeWidth={2} />
            {isSending
              ? 'Sending…'
              : sendArmed
                ? 'Confirm send'
                : 'Send'}
          </button>

          <span className="text-cloud-dark text-[10px]">·</span>

          {/* Reject button — two-tap confirm */}
          <button
            type="button"
            disabled={isProcessing}
            onClick={handleRejectClick}
            className={[
              'inline-flex items-center gap-[5px]',
              'text-[11px] font-mono tracking-[0.04em] uppercase',
              'transition-colors duration-fast cursor-pointer',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              rejectArmed
                ? 'text-faded-red font-medium'
                : 'text-text-body-secondary hover:text-text-heading',
            ].join(' ')}
          >
            <Trash2 size={10} strokeWidth={2} />
            {isRejecting
              ? 'Rejecting…'
              : rejectArmed
                ? 'Confirm reject'
                : 'Reject'}
          </button>
        </div>
      )}
    </div>
  );
}
