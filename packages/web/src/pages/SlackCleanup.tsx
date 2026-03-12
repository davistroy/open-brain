import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Hash,
  RefreshCw,
  AlertCircle,
  Archive,
  ArrowUpDown,
  Filter,
  Loader2,
  CheckCircle,
  Users,
  Calendar,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { adminApi } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SlackChannel {
  id: string;
  name: string;
  member_count: number;
  last_activity: string | null;
  days_inactive: number;
  topic?: string;
  purpose?: string;
  is_archived: boolean;
}

type SortField = 'name' | 'member_count' | 'days_inactive' | 'last_activity';
type SortDirection = 'asc' | 'desc';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function inactivityBadgeVariant(days: number): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (days >= 90) return 'destructive';
  if (days >= 30) return 'default';
  return 'secondary';
}

function sortChannels(
  channels: SlackChannel[],
  field: SortField,
  direction: SortDirection,
): SlackChannel[] {
  return [...channels].sort((a, b) => {
    let cmp = 0;
    switch (field) {
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
        const aDate = a.last_activity ? new Date(a.last_activity).getTime() : 0;
        const bDate = b.last_activity ? new Date(b.last_activity).getTime() : 0;
        cmp = aDate - bDate;
        break;
      }
    }
    return direction === 'asc' ? cmp : -cmp;
  });
}

// ─── Archive Confirmation Modal ───────────────────────────────────────────────

const ARCHIVE_CONFIRM_PHRASE = 'ARCHIVE';

function ArchiveConfirmModal({
  channel,
  onConfirm,
  onCancel,
  archiving,
}: {
  channel: SlackChannel;
  onConfirm: () => void;
  onCancel: () => void;
  archiving: boolean;
}) {
  const [confirmText, setConfirmText] = useState('');
  const confirmed = confirmText === ARCHIVE_CONFIRM_PHRASE;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
      <div className="bg-card border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-destructive/10 p-2 shrink-0">
            <Archive className="h-5 w-5 text-destructive" />
          </div>
          <h3 className="text-base font-semibold">Archive Channel?</h3>
        </div>

        <p className="text-sm text-muted-foreground">
          You are about to archive <strong>#{channel.name}</strong>. This will:
        </p>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>Remove the channel from the active channel list</li>
          <li>Prevent new messages from being posted</li>
          <li>Preserve message history (can be unarchived later)</li>
        </ul>

        <div className="rounded-lg border bg-muted/50 p-3 text-sm">
          <div className="grid grid-cols-2 gap-2 text-muted-foreground">
            <span>Members:</span>
            <span className="font-medium text-foreground">{channel.member_count}</span>
            <span>Days inactive:</span>
            <span className="font-medium text-foreground">{channel.days_inactive}</span>
            <span>Last activity:</span>
            <span className="font-medium text-foreground">{formatDate(channel.last_activity)}</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            Type{' '}
            <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">{ARCHIVE_CONFIRM_PHRASE}</span>
            {' '}to confirm:
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={ARCHIVE_CONFIRM_PHRASE}
            className="font-mono"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancel();
              if (e.key === 'Enter' && confirmed && !archiving) onConfirm();
            }}
          />
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={archiving}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!confirmed || archiving}
            onClick={onConfirm}
          >
            {archiving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                Archiving...
              </>
            ) : (
              'Confirm Archive'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Sortable Column Header ──────────────────────────────────────────────────

function SortableHeader({
  label,
  field,
  currentField,
  currentDirection,
  onSort,
}: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDirection: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const isActive = currentField === field;
  return (
    <button
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => onSort(field)}
    >
      {label}
      <ArrowUpDown
        className={`h-3 w-3 ${isActive ? 'text-foreground' : 'opacity-40'}`}
      />
      {isActive && (
        <span className="text-[10px]">{currentDirection === 'asc' ? '\u2191' : '\u2193'}</span>
      )}
    </button>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function SlackCleanup() {
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Sort state
  const [sortField, setSortField] = useState<SortField>('days_inactive');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Filter state
  const [thresholdDays, setThresholdDays] = useState<number>(30);
  const [showArchived, setShowArchived] = useState(false);

  // Archive state
  const [archiveTarget, setArchiveTarget] = useState<SlackChannel | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveResult, setArchiveResult] = useState<{ success: boolean; message: string; channelName: string } | null>(null);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const loadChannels = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApi.getSlackChannels();
      setChannels(res.channels ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Slack channels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadChannels();
    setRefreshing(false);
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'name' ? 'asc' : 'desc');
    }
  }

  async function handleArchive() {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await adminApi.archiveSlackChannel(archiveTarget.id);
      setArchiveResult({
        success: true,
        message: `#${archiveTarget.name} has been archived.`,
        channelName: archiveTarget.name,
      });
      setArchiveTarget(null);
      // Refresh channel list
      await loadChannels();
    } catch (err) {
      setArchiveResult({
        success: false,
        message: err instanceof Error ? err.message : 'Archive failed',
        channelName: archiveTarget.name,
      });
      setArchiveTarget(null);
    } finally {
      setArchiving(false);
      // Clear result after 6 seconds
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
      resultTimerRef.current = setTimeout(() => setArchiveResult(null), 6000);
    }
  }

  // Filter and sort
  const filteredChannels = channels.filter((ch) => {
    if (!showArchived && ch.is_archived) return false;
    if (thresholdDays > 0 && ch.days_inactive < thresholdDays) return false;
    return true;
  });

  const sortedChannels = sortChannels(filteredChannels, sortField, sortDirection);

  const totalInactive = channels.filter((ch) => !ch.is_archived && ch.days_inactive >= 30).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Hash className="h-6 w-6 text-primary" />
            Slack Channel Cleanup
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review and archive inactive Slack channels to keep your workspace organized.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Summary stats */}
      {!loading && !error && channels.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-bold">{channels.filter((c) => !c.is_archived).length}</div>
            <div className="text-xs text-muted-foreground">Active Channels</div>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">{totalInactive}</div>
            <div className="text-xs text-muted-foreground">Inactive (30+ days)</div>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="text-2xl font-bold text-muted-foreground">{channels.filter((c) => c.is_archived).length}</div>
            <div className="text-xs text-muted-foreground">Archived</div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Failed to load channels</p>
            <p className="text-xs mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Archive result toast */}
      {archiveResult && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${
            archiveResult.success
              ? 'bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800'
              : 'bg-destructive/10 text-destructive border-destructive/30'
          }`}
        >
          {archiveResult.success ? (
            <CheckCircle className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          {archiveResult.message}
        </div>
      )}

      {/* Filter controls */}
      {!loading && !error && channels.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Inactive for at least</span>
            <Input
              type="number"
              min={0}
              value={thresholdDays}
              onChange={(e) => setThresholdDays(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-20 h-8 text-sm"
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded border-input"
            />
            Show archived
          </label>
          <span className="text-xs text-muted-foreground ml-auto">
            {sortedChannels.length} channel{sortedChannels.length !== 1 ? 's' : ''} shown
          </span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-secondary" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && channels.length === 0 && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Hash className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No Slack channels found</p>
          <p className="text-xs text-muted-foreground mt-1">
            Make sure the Slack API token is configured and the bot has access to list channels.
          </p>
        </div>
      )}

      {/* No results after filter */}
      {!loading && !error && channels.length > 0 && sortedChannels.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <p className="text-sm">No channels match the current filters.</p>
          <p className="text-xs mt-1">Try lowering the inactivity threshold or enabling archived channels.</p>
        </div>
      )}

      {/* Channel table */}
      {!loading && !error && sortedChannels.length > 0 && (
        <div className="rounded-lg border bg-card overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_100px_120px_100px_80px] gap-4 px-4 py-3 bg-muted/50 border-b">
            <SortableHeader
              label="Channel"
              field="name"
              currentField={sortField}
              currentDirection={sortDirection}
              onSort={handleSort}
            />
            <SortableHeader
              label="Members"
              field="member_count"
              currentField={sortField}
              currentDirection={sortDirection}
              onSort={handleSort}
            />
            <SortableHeader
              label="Last Activity"
              field="last_activity"
              currentField={sortField}
              currentDirection={sortDirection}
              onSort={handleSort}
            />
            <SortableHeader
              label="Days Idle"
              field="days_inactive"
              currentField={sortField}
              currentDirection={sortDirection}
              onSort={handleSort}
            />
            <span className="text-xs font-medium text-muted-foreground">Action</span>
          </div>

          {/* Table rows */}
          <div className="divide-y">
            {sortedChannels.map((channel) => (
              <div
                key={channel.id}
                className={`grid grid-cols-[1fr_100px_120px_100px_80px] gap-4 px-4 py-3 items-center text-sm ${
                  channel.is_archived ? 'opacity-50' : ''
                }`}
              >
                {/* Channel name */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="font-medium truncate">{channel.name}</span>
                    {channel.is_archived && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">archived</Badge>
                    )}
                  </div>
                  {(channel.topic || channel.purpose) && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate ml-5.5">
                      {channel.topic || channel.purpose}
                    </p>
                  )}
                </div>

                {/* Member count */}
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  <span>{channel.member_count}</span>
                </div>

                {/* Last activity */}
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <Calendar className="h-3.5 w-3.5 shrink-0" />
                  <span>{formatDate(channel.last_activity)}</span>
                </div>

                {/* Days inactive */}
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <Badge variant={inactivityBadgeVariant(channel.days_inactive)} className="text-xs">
                    {channel.days_inactive}d
                  </Badge>
                </div>

                {/* Archive action */}
                <div>
                  {!channel.is_archived ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                      onClick={() => setArchiveTarget(channel)}
                    >
                      <Archive className="h-3 w-3" />
                      Archive
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">--</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Archive confirmation modal */}
      {archiveTarget && (
        <ArchiveConfirmModal
          channel={archiveTarget}
          onConfirm={handleArchive}
          onCancel={() => setArchiveTarget(null)}
          archiving={archiving}
        />
      )}
    </div>
  );
}
