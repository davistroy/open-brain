'use client';

/**
 * ChannelTable — sortable Slack channel table with inactivity threshold filter
 * and archive action with confirmation modal.
 *
 * Features:
 *   - Summary cards: total channels, archived count, channels above threshold
 *   - Inactivity threshold dropdown: 30 / 60 / 90 / 180 days
 *   - Sort by column header (ascending / descending toggle)
 *   - Archive action — requires typing the channel name to confirm
 *   - Summary cards update when threshold filter changes
 *
 * Route: /slack-cleanup
 */

import { useState, useMemo, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Archive,
  Hash,
  Users,
  Clock,
  AlertTriangle,
  X,
} from 'lucide-react';
import { Card, Button, EmptyState } from '@/components/design-system';
import { useClientNow } from '@/hooks/useClientNow';
import { useArchiveSlackChannel } from '@/lib/api/admin.hooks';
import type { SlackChannel } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortKey = 'name' | 'member_count' | 'last_activity' | 'days_inactive';
type SortDir = 'asc' | 'desc';

type ThresholdDays = 30 | 60 | 90 | 180;

const THRESHOLD_OPTIONS: { value: ThresholdDays; label: string }[] = [
  { value: 30,  label: '30 days' },
  { value: 60,  label: '60 days' },
  { value: 90,  label: '90 days' },
  { value: 180, label: '180 days' },
];

interface ChannelTableProps {
  initialChannels: SlackChannel[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLastActivity(iso: string | null, now: number | null): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  // Pre-mount (SSR + first client render): stable absolute date, no `now` dependency.
  if (now === null) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const diffMs = now - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / 3_600_000);
    if (diffHours === 0) return 'Just now';
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function daysInactiveColor(days: number, threshold: ThresholdDays): string {
  if (days >= threshold) return 'text-status-error-fg';
  if (days >= threshold * 0.6) return 'text-[var(--color-terracotta)]';
  return 'text-text-body-secondary';
}

// ---------------------------------------------------------------------------
// SortIcon
// ---------------------------------------------------------------------------

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <ChevronsUpDown size={10} strokeWidth={1.5} className="opacity-30" />;
  return sortDir === 'asc'
    ? <ChevronUp size={10} strokeWidth={2} className="text-book-cloth" />
    : <ChevronDown size={10} strokeWidth={2} className="text-book-cloth" />;
}

// ---------------------------------------------------------------------------
// SummaryCard
// ---------------------------------------------------------------------------

interface SummaryCardProps {
  label: string;
  value: number | string;
  subtext?: string;
  accent?: boolean;
}

function SummaryCard({ label, value, subtext, accent }: SummaryCardProps) {
  return (
    <div className="flex-1 min-w-0 px-[18px] py-[14px] border-r border-cloud-light last:border-r-0">
      <div className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-text-body-secondary mb-[8px]">
        {label}
      </div>
      <div
        className="font-display text-[28px] font-light tracking-[-0.02em] leading-none"
        style={{
          color: accent ? 'var(--color-terracotta)' : 'var(--color-text-heading)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      {subtext && (
        <div className="text-[12px] text-text-body-secondary mt-[6px] font-light">
          {subtext}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArchiveModal
// ---------------------------------------------------------------------------

interface ArchiveModalProps {
  channel: SlackChannel | null;
  onClose: () => void;
  onConfirm: (id: string) => void;
  isLoading: boolean;
}

function ArchiveModal({ channel, onClose, onConfirm, isLoading }: ArchiveModalProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const channelName = channel?.name ?? '';
  const isValid = inputValue.trim() === channelName;

  function handleOpenChange(open: boolean) {
    if (!open) {
      setInputValue('');
      onClose();
    }
  }

  function handleConfirm() {
    if (!isValid || !channel) return;
    onConfirm(channel.id);
  }

  return (
    <Dialog.Root open={channel !== null} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        {/* Overlay */}
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        {/* Content */}
        <Dialog.Content
          className={[
            'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            'z-50 w-[440px] max-w-[calc(100vw-32px)]',
            'bg-bg-container border border-cloud-light',
            'p-0 rounded-none shadow-lg',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
            'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
          ].join(' ')}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            // Focus input after open animation settles
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
        >
          {/* Header */}
          <div className="flex items-start justify-between px-[20px] py-[14px] border-b border-cloud-light">
            <div className="flex items-center gap-[10px]">
              <AlertTriangle
                size={16}
                strokeWidth={1.5}
                className="text-[var(--color-terracotta)] shrink-0 mt-[1px]"
              />
              <Dialog.Title className="font-display text-[16px] font-normal tracking-[-0.005em] text-text-heading m-0">
                Archive channel
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="text-text-body-secondary hover:text-text-heading transition-colors cursor-pointer border-none bg-transparent p-[2px]"
                aria-label="Close"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="px-[20px] py-[18px] space-y-[14px]">
            <Dialog.Description className="text-[13px] text-text-body font-light leading-[1.55] m-0">
              Archiving{' '}
              <span className="font-mono text-[12.5px] bg-ivory-dark px-[5px] py-[1px] border border-cloud-light">
                #{channelName}
              </span>{' '}
              will make it read-only. Members can no longer post messages.
              This action can be undone from Slack workspace settings.
            </Dialog.Description>

            <div>
              <label
                htmlFor="archive-confirm-input"
                className="font-body text-[12.5px] font-normal text-text-body-secondary tracking-[0.005em] block mb-[6px]"
              >
                Type{' '}
                <span className="font-mono text-text-body">
                  {channelName}
                </span>{' '}
                to confirm
              </label>
              <input
                id="archive-confirm-input"
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isValid) handleConfirm();
                  if (e.key === 'Escape') handleOpenChange(false);
                }}
                placeholder={channelName}
                autoComplete="off"
                spellCheck={false}
                className={[
                  'w-full h-[30px]',
                  'bg-bg-container border rounded-none',
                  'font-mono text-[13px] font-light text-text-body',
                  'outline-none pl-[12px] pr-[12px]',
                  'transition-[border-color] duration-[120ms]',
                  isValid
                    ? 'border-[var(--color-success)] focus:border-[var(--color-success)]'
                    : 'border-cloud-medium focus:border-slate-medium',
                ].filter(Boolean).join(' ')}
              />
              {inputValue && !isValid && (
                <div className="text-[11.5px] text-text-body-secondary mt-[4px] font-light">
                  Channel name must match exactly
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-[8px] px-[20px] py-[12px] border-t border-cloud-light">
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm">
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              variant="primary"
              size="sm"
              disabled={!isValid || isLoading}
              onClick={handleConfirm}
              className={[
                'bg-[var(--color-terracotta)] border-[var(--color-terracotta)]',
                'hover:bg-[color-mix(in_srgb,var(--color-terracotta)_85%,black)]',
                'hover:border-[color-mix(in_srgb,var(--color-terracotta)_85%,black)]',
              ].join(' ')}
            >
              {isLoading ? 'Archiving…' : 'Archive channel'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// ChannelTable
// ---------------------------------------------------------------------------

export function ChannelTable({ initialChannels }: ChannelTableProps) {
  // Local channel list — starts from server-prefetched data
  const [channels, setChannels] = useState<SlackChannel[]>(initialChannels);

  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>('days_inactive');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Inactivity threshold filter
  const [threshold, setThreshold] = useState<ThresholdDays>(90);

  // Archive modal state
  const [archiveTarget, setArchiveTarget] = useState<SlackChannel | null>(null);

  function handleSort(col: SortKey) {
    if (col === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col);
      setSortDir(col === 'name' ? 'asc' : 'desc');
    }
  }

  // Archive mutation
  const archiveMutation = useArchiveSlackChannel();

  const handleArchiveConfirm = useCallback(
    (id: string) => {
      archiveMutation.mutate(id, {
        onSuccess: () => {
          setChannels((prev) =>
            prev.map((ch) => (ch.id === id ? { ...ch, is_archived: true } : ch)),
          );
          toast.success(`#${archiveTarget?.name ?? id} archived`);
          setArchiveTarget(null);
        },
        onError: (err) => {
          console.error('[ChannelTable] archive failed for channel:', id, err);
          toast.error('Failed to archive channel — please try again.');
        },
      });
    },
    [archiveMutation, archiveTarget],
  );

  // Filtered + sorted channels
  const visibleChannels = useMemo(() => {
    const filtered = channels.filter(
      (ch) => !ch.is_archived && ch.days_inactive >= threshold,
    );

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'member_count':
          cmp = a.member_count - b.member_count;
          break;
        case 'days_inactive':
          cmp = a.days_inactive - b.days_inactive;
          break;
        case 'last_activity': {
          const aMs = a.last_activity ? new Date(a.last_activity).getTime() : 0;
          const bMs = b.last_activity ? new Date(b.last_activity).getTime() : 0;
          cmp = aMs - bMs;
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [channels, threshold, sortKey, sortDir]);

  // Summary stats
  const totalChannels = channels.length;
  const archivedCount = channels.filter((ch) => ch.is_archived).length;
  const aboveThreshold = channels.filter(
    (ch) => !ch.is_archived && ch.days_inactive >= threshold,
  ).length;

  function SortableHeader({
    col,
    label,
    className = '',
  }: {
    col: SortKey;
    label: string;
    className?: string;
  }) {
    return (
      <button
        type="button"
        onClick={() => handleSort(col)}
        className={[
          'inline-flex items-center gap-[5px]',
          'font-mono text-[10px] tracking-[0.08em] text-text-body-secondary uppercase',
          'bg-transparent border-none cursor-pointer p-0',
          'hover:text-text-heading transition-colors duration-fast',
          sortKey === col ? 'text-text-heading' : '',
          className,
        ].filter(Boolean).join(' ')}
      >
        {label}
        <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
      </button>
    );
  }

  return (
    <>
      {/* Summary strip */}
      <div className="flex bg-bg-container border border-cloud-light mb-[20px]">
        <SummaryCard
          label="Total channels"
          value={totalChannels}
          subtext="Public channels visible to token"
        />
        <SummaryCard
          label="Archived"
          value={archivedCount}
          subtext={archivedCount > 0 ? 'Already archived' : 'None archived yet'}
        />
        <SummaryCard
          label={`Inactive > ${threshold}d`}
          value={aboveThreshold}
          subtext="Matching current threshold"
          accent={aboveThreshold > 0}
        />
      </div>

      {/* Channel table */}
      <Card padded={false}>
        {/* Toolbar */}
        <div className="flex items-center gap-[12px] px-[14px] py-[10px] border-b border-cloud-medium flex-wrap">
          {/* Threshold filter */}
          <div className="flex items-center gap-[8px]">
            <span className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-text-body-secondary">
              Inactive &gt;
            </span>
            <select
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value) as ThresholdDays)}
              className={[
                'h-[30px] bg-bg-container border border-cloud-medium rounded-none',
                'font-mono text-[12px] font-light text-text-body pl-[8px] pr-[24px]',
                'outline-none focus:border-slate-medium',
                'transition-[border-color] duration-[120ms] cursor-pointer',
                'appearance-none',
              ].join(' ')}
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 6px center',
              }}
              aria-label="Inactivity threshold"
            >
              {THRESHOLD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1" />

          {/* Result count */}
          <span className="font-mono text-[10.5px] text-text-body-secondary tracking-[0.03em]">
            {visibleChannels.length} channel{visibleChannels.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Column headers */}
        <div
          className="grid px-[18px] py-[10px] border-b border-cloud-medium gap-[12px]"
          style={{ gridTemplateColumns: '20px 1fr 100px 140px 120px 80px' }}
        >
          <span />
          <SortableHeader col="name" label="Channel" />
          <SortableHeader col="member_count" label="Members" />
          <SortableHeader col="last_activity" label="Last activity" />
          <SortableHeader col="days_inactive" label="Days inactive" />
          <span className="font-mono text-[10px] tracking-[0.08em] text-text-body-secondary uppercase text-right">
            Action
          </span>
        </div>

        {/* Rows */}
        {visibleChannels.length === 0 ? (
          <EmptyState
            icon={Hash}
            title="No inactive channels"
            description={`No active channels have been inactive for more than ${threshold} days. Try lowering the threshold.`}
            className="py-12"
          />
        ) : (
          <div>
            {visibleChannels.map((ch, i) => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                threshold={threshold}
                isLast={i === visibleChannels.length - 1}
                onArchive={() => setArchiveTarget(ch)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Archive confirmation modal */}
      <ArchiveModal
        channel={archiveTarget}
        onClose={() => setArchiveTarget(null)}
        onConfirm={handleArchiveConfirm}
        isLoading={archiveMutation.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// ChannelRow
// ---------------------------------------------------------------------------

interface ChannelRowProps {
  channel: SlackChannel;
  threshold: ThresholdDays;
  isLast: boolean;
  onArchive: () => void;
}

function ChannelRow({ channel, threshold, isLast, onArchive }: ChannelRowProps) {
  const now = useClientNow();
  const inactiveColor = daysInactiveColor(channel.days_inactive, threshold);
  const isHighRisk = channel.days_inactive >= threshold;

  return (
    <div
      className={[
        'grid items-center px-[18px] py-[10px] gap-[12px]',
        'transition-colors duration-fast',
        isHighRisk ? 'hover:bg-[color-mix(in_srgb,var(--color-terracotta)_4%,transparent)]' : 'hover:bg-ivory-dark',
        !isLast ? 'border-b border-cloud-light' : '',
      ].filter(Boolean).join(' ')}
      style={{ gridTemplateColumns: '20px 1fr 100px 140px 120px 80px' }}
    >
      {/* Icon */}
      <Hash size={12} strokeWidth={1.5} className="text-cloud-dark" />

      {/* Channel name + purpose */}
      <div className="min-w-0">
        <div className="font-mono text-[13px] text-text-body truncate">
          #{channel.name}
        </div>
        {channel.purpose && (
          <div className="text-[11.5px] text-text-body-secondary font-light truncate mt-[1px] leading-[1.4]">
            {channel.purpose}
          </div>
        )}
      </div>

      {/* Member count */}
      <div className="flex items-center gap-[5px] text-text-body-secondary">
        <Users size={11} strokeWidth={1.5} className="shrink-0" />
        <span className="font-mono text-[12px]">{channel.member_count}</span>
      </div>

      {/* Last activity */}
      <div className="flex items-center gap-[5px] text-text-body-secondary">
        <Clock size={11} strokeWidth={1.5} className="shrink-0" />
        <span className="text-[12px] font-light">
          {formatLastActivity(channel.last_activity, now)}
        </span>
      </div>

      {/* Days inactive */}
      <div className={['font-mono text-[12.5px] font-normal', inactiveColor].join(' ')}>
        {channel.days_inactive}d
      </div>

      {/* Archive action */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onArchive}
          className={[
            'inline-flex items-center gap-[5px]',
            'font-mono text-[10.5px] tracking-[0.04em] uppercase',
            'text-text-body-secondary hover:text-[var(--color-terracotta)]',
            'transition-colors duration-fast cursor-pointer',
            'border-none bg-transparent p-0',
          ].join(' ')}
          aria-label={`Archive #${channel.name}`}
        >
          <Archive size={11} strokeWidth={1.5} />
          Archive
        </button>
      </div>
    </div>
  );
}

// Re-export SlackChannel so callers importing from this component don't need a
// separate import from api-client.
export type { SlackChannel };
