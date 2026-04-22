'use client';

/**
 * EmailTabs — 3-tab client shell for the Email page (M3, work item 6.3).
 *
 * Tabs:
 *   Inbound  — email captures (source='email'), filterable by sender/date
 *   Drafts   — outbound email drafts with send/reject actions
 *   Threads  — client-side thread reconstruction of inbound email captures
 *
 * State owned here:
 *   - activeTab: 'inbound' | 'drafts' | 'threads'
 *   - senderFilter, dateFrom, dateTo (filter bar, shared across Inbound + Threads)
 *   - drafts list (server-prefetched, updated optimistically on send/reject)
 *
 * Mutations:
 *   - sendMutation: POST /api/v1/email/drafts/:id/send → remove from pending list
 *   - rejectMutation: DELETE /api/v1/email/drafts/:id → remove from pending list
 *
 * TanStack Query note: draft mutations use optimistic removal so the list
 * updates immediately without a refetch. Full refetch on error (rollback).
 */

import { useState, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Inbox,
  FileEdit,
  MessageSquare,
  Filter,
  X,
  Mail,
} from 'lucide-react';
import { EmptyState, Input } from '@/components/design-system';
import { DraftCard } from './DraftCard';
import { ThreadView } from './ThreadView';
import { emailApi, type EmailDraft } from '@/lib/api-client';
import type { Capture } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'inbound' | 'drafts' | 'threads';

interface Tab {
  id: TabId;
  label: string;
  count?: number;
}

interface EmailTabsProps {
  initialCaptures: Capture[];
  initialDrafts: EmailDraft[];
}

// ---------------------------------------------------------------------------
// Date formatters + helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
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

/**
 * Extract sender from a capture's source_metadata or fall back to empty string.
 * Used for filter matching in the Inbound tab.
 */
function extractFrom(capture: Capture): string {
  const meta = (capture as unknown as { source_metadata?: Record<string, unknown> })
    .source_metadata;
  if (meta && typeof meta === 'object') {
    const from = meta['from'] ?? meta['From'] ?? meta['sender'];
    if (typeof from === 'string') return from.toLowerCase();
  }
  return '';
}

// ---------------------------------------------------------------------------
// InboundCapture — single row in the Inbound tab
// ---------------------------------------------------------------------------

function InboundCapture({ capture }: { capture: Capture }) {
  const preview = capture.content.length > 200
    ? `${capture.content.slice(0, 200).trimEnd()}…`
    : capture.content;

  return (
    <div className="bg-bg-container border border-cloud-light p-4 flex items-start gap-4">
      {/* Mail icon */}
      <div className="shrink-0 mt-[2px]">
        <Mail
          size={14}
          strokeWidth={1.3}
          className="text-cloud-dark"
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-[4px]">
        <p className="text-[13px] text-text-body leading-[1.5] font-light m-0">
          {preview}
        </p>

        {/* Meta row */}
        <div className="flex items-center gap-[8px]">
          <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary">
            {capture.capture_type}
          </span>
          <span className="text-cloud-dark opacity-40 text-[10px]">·</span>
          <span className="font-mono text-[10px] tracking-[0.05em] text-text-body-secondary">
            {formatRelative(capture.created_at)}
          </span>
          {capture.brain_view && (
            <>
              <span className="text-cloud-dark opacity-40 text-[10px]">·</span>
              <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary opacity-70">
                {capture.brain_view}
              </span>
            </>
          )}
          {capture.pipeline_status !== 'complete' && (
            <>
              <span className="text-cloud-dark opacity-40 text-[10px]">·</span>
              <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-text-body-secondary opacity-60">
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
// InboundPanel
// ---------------------------------------------------------------------------

interface InboundPanelProps {
  captures: Capture[];
  senderFilter: string;
  dateFrom: string;
  dateTo: string;
}

function InboundPanel({ captures, senderFilter, dateFrom, dateTo }: InboundPanelProps) {
  const filtered = useMemo(() => {
    let result = captures;

    if (senderFilter.trim()) {
      const lower = senderFilter.trim().toLowerCase();
      result = result.filter(
        (c) =>
          extractFrom(c).includes(lower) ||
          c.content.toLowerCase().includes(lower),
      );
    }

    if (dateFrom) {
      const fromMs = new Date(dateFrom).getTime();
      result = result.filter((c) => new Date(c.created_at).getTime() >= fromMs);
    }
    if (dateTo) {
      const toMs = new Date(dateTo).getTime() + 86_400_000 - 1;
      result = result.filter((c) => new Date(c.created_at).getTime() <= toMs);
    }

    return result;
  }, [captures, senderFilter, dateFrom, dateTo]);

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No inbound email captures"
        description={
          senderFilter || dateFrom || dateTo
            ? 'No captures match the current filters. Try adjusting the sender or date range.'
            : 'Inbound emails are captured via brain@troy-davis.com. Configure the sender allowlist in Settings.'
        }
      />
    );
  }

  return (
    <div className="space-y-[6px]">
      {filtered.map((capture) => (
        <InboundCapture key={capture.id} capture={capture} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DraftsPanel
// ---------------------------------------------------------------------------

interface DraftsPanelProps {
  drafts: EmailDraft[];
  onSend: (id: string) => void;
  onReject: (id: string) => void;
  sendingId: string | null;
  rejectingId: string | null;
}

function DraftsPanel({
  drafts,
  onSend,
  onReject,
  sendingId,
  rejectingId,
}: DraftsPanelProps) {
  const pendingDrafts = drafts.filter(
    (d) => d.status === 'draft' || d.status === 'approved',
  );
  const otherDrafts = drafts.filter(
    (d) => d.status !== 'draft' && d.status !== 'approved',
  );

  if (drafts.length === 0) {
    return (
      <EmptyState
        icon={FileEdit}
        title="No email drafts"
        description="Email drafts are created by the email-compose skill when the system generates outbound email proposals."
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Pending review */}
      {pendingDrafts.length > 0 && (
        <section>
          <div className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-text-body-secondary mb-3">
            Awaiting review — {pendingDrafts.length}
          </div>
          <div className="space-y-[6px]">
            {pendingDrafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                onSend={onSend}
                onReject={onReject}
                isSending={sendingId === draft.id}
                isRejecting={rejectingId === draft.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* Sent / rejected history */}
      {otherDrafts.length > 0 && (
        <section>
          <div className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-text-body-secondary mb-3">
            History — {otherDrafts.length}
          </div>
          <div className="space-y-[6px]">
            {otherDrafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                onSend={onSend}
                onReject={onReject}
                isSending={sendingId === draft.id}
                isRejecting={rejectingId === draft.id}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

interface FilterBarProps {
  senderFilter: string;
  onSenderChange: (v: string) => void;
  dateFrom: string;
  onDateFromChange: (v: string) => void;
  dateTo: string;
  onDateToChange: (v: string) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}

function FilterBar({
  senderFilter,
  onSenderChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  onClear,
  hasActiveFilters,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-5 pb-4 border-b border-cloud-light">
      {/* Filter icon */}
      <div className="flex items-center gap-2 shrink-0 pt-[18px]">
        <Filter
          size={13}
          strokeWidth={1.5}
          className="text-text-body-secondary"
        />
        <span className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary">
          Filter
        </span>
      </div>

      {/* Sender filter */}
      <div className="flex-1 min-w-[180px] max-w-[260px]">
        <Input
          label="Sender"
          placeholder="e.g. alice@example.com"
          value={senderFilter}
          onChange={(e) => onSenderChange(e.target.value)}
        />
      </div>

      {/* Date from */}
      <div className="w-[148px]">
        <Input
          label="From date"
          type="date"
          value={dateFrom}
          onChange={(e) => onDateFromChange(e.target.value)}
        />
      </div>

      {/* Date to */}
      <div className="w-[148px]">
        <Input
          label="To date"
          type="date"
          value={dateTo}
          onChange={(e) => onDateToChange(e.target.value)}
        />
      </div>

      {/* Clear button */}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={onClear}
          className={[
            'inline-flex items-center gap-[5px] mb-[1px]',
            'font-mono text-[10.5px] tracking-[0.05em] uppercase',
            'text-text-body-secondary hover:text-text-heading',
            'transition-colors duration-fast cursor-pointer',
            'border-none bg-transparent',
          ].join(' ')}
        >
          <X size={10} strokeWidth={2} />
          Clear
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmailTabs
// ---------------------------------------------------------------------------

export function EmailTabs({ initialCaptures, initialDrafts }: EmailTabsProps) {
  const queryClient = useQueryClient();

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>('inbound');

  // Local draft list — starts from server-prefetched data
  const [drafts, setDrafts] = useState<EmailDraft[]>(initialDrafts);

  // Track which draft IDs are in-flight for action buttons
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  // Filter bar state — shared across Inbound + Threads tabs
  const [senderFilter, setSenderFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const hasActiveFilters = Boolean(senderFilter || dateFrom || dateTo);

  function clearFilters() {
    setSenderFilter('');
    setDateFrom('');
    setDateTo('');
  }

  // ---- Send mutation ----
  const sendMutation = useMutation({
    mutationFn: (id: string) => emailApi.send(id),
    onMutate: (id) => {
      setSendingId(id);
    },
    onSuccess: (result) => {
      // Optimistic update: replace draft with updated status
      setDrafts((prev) =>
        prev.map((d) =>
          d.id === result.id
            ? { ...d, status: result.status, sent_at: result.sent_at }
            : d,
        ),
      );
      toast.success('Email sent successfully');
      queryClient.invalidateQueries({ queryKey: ['email-drafts'] });
    },
    onError: (err, id) => {
      console.error('[EmailTabs] send failed for draft:', id, err);
      toast.error('Failed to send email — please try again.');
    },
    onSettled: () => {
      setSendingId(null);
    },
  });

  // ---- Reject mutation ----
  const rejectMutation = useMutation({
    mutationFn: (id: string) => emailApi.reject(id),
    onMutate: (id) => {
      setRejectingId(id);
    },
    onSuccess: (result) => {
      // Optimistic update: replace draft status with 'rejected'
      setDrafts((prev) =>
        prev.map((d) =>
          d.id === result.id ? { ...d, status: result.status } : d,
        ),
      );
      toast.success('Draft rejected');
      queryClient.invalidateQueries({ queryKey: ['email-drafts'] });
    },
    onError: (err, id) => {
      console.error('[EmailTabs] reject failed for draft:', id, err);
      toast.error('Failed to reject draft — please try again.');
    },
    onSettled: () => {
      setRejectingId(null);
    },
  });

  // Tab definitions with dynamic counts
  const pendingDraftCount = drafts.filter(
    (d) => d.status === 'draft' || d.status === 'approved',
  ).length;

  const tabs: Tab[] = [
    { id: 'inbound',  label: 'Inbound',  count: initialCaptures.length },
    { id: 'drafts',   label: 'Drafts',   count: pendingDraftCount > 0 ? pendingDraftCount : undefined },
    { id: 'threads',  label: 'Threads' },
  ];

  // Show filter bar for inbound + threads (not relevant for drafts)
  const showFilterBar = activeTab === 'inbound' || activeTab === 'threads';

  return (
    <div>
      {/* Tab bar */}
      <div className="flex border-b border-cloud-light mb-[18px]" role="tablist">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;

          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
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
              ].filter(Boolean).join(' ')}
            >
              {/* Tab icon */}
              {tab.id === 'inbound'  && <Inbox         size={12} strokeWidth={1.5} />}
              {tab.id === 'drafts'   && <FileEdit       size={12} strokeWidth={1.5} />}
              {tab.id === 'threads'  && <MessageSquare  size={12} strokeWidth={1.5} />}

              {tab.label}

              {/* Count badge */}
              {tab.count != null && tab.count > 0 && (
                <span className="font-mono text-[10.5px] text-text-body-secondary font-normal">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Filter bar — Inbound + Threads only */}
      {showFilterBar && (
        <FilterBar
          senderFilter={senderFilter}
          onSenderChange={setSenderFilter}
          dateFrom={dateFrom}
          onDateFromChange={setDateFrom}
          dateTo={dateTo}
          onDateToChange={setDateTo}
          onClear={clearFilters}
          hasActiveFilters={hasActiveFilters}
        />
      )}

      {/* Tab panels */}
      <div
        id={`tabpanel-${activeTab}`}
        role="tabpanel"
        aria-label={tabs.find((t) => t.id === activeTab)?.label ?? activeTab}
      >
        {activeTab === 'inbound' && (
          <InboundPanel
            captures={initialCaptures}
            senderFilter={senderFilter}
            dateFrom={dateFrom}
            dateTo={dateTo}
          />
        )}

        {activeTab === 'drafts' && (
          <DraftsPanel
            drafts={drafts}
            onSend={(id) => sendMutation.mutate(id)}
            onReject={(id) => rejectMutation.mutate(id)}
            sendingId={sendingId}
            rejectingId={rejectingId}
          />
        )}

        {activeTab === 'threads' && (
          <ThreadView
            captures={initialCaptures}
            senderFilter={senderFilter}
            dateFrom={dateFrom}
            dateTo={dateTo}
          />
        )}
      </div>
    </div>
  );
}
