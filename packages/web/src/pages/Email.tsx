import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Mail,
  MailOpen,
  Send,
  RefreshCw,
  Check,
  X,
  AlertCircle,
  Inbox,
  FileEdit,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Filter,
  Calendar,
  User,
  Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { emailApi, capturesApi } from '@/lib/api';
import CaptureCard from '@/components/CaptureCard';
import { EmailComposeDrawer } from '@/components/EmailComposeDrawer';
import type { EmailDraft, Capture } from '@/lib/types';
import { cn, formatRelativeTime } from '@/lib/utils';

// ─── Status badge helpers ───────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  approved: 'bg-blue-100 text-blue-800 border-blue-200',
  sent: 'bg-green-100 text-green-800 border-green-200',
  rejected: 'bg-gray-100 text-gray-600 border-gray-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
};

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  draft: FileEdit,
  approved: Check,
  sent: Send,
  rejected: X,
  failed: AlertCircle,
};

// ─── DraftCard ──────────────────────────────────────────────────────────────

interface DraftCardProps {
  draft: EmailDraft;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit?: (id: string) => void;
  actionLoading: string | null;
}

function DraftCard({ draft, onApprove, onReject, onEdit, actionLoading }: DraftCardProps) {
  const [expanded, setExpanded] = useState(false);
  const StatusIcon = STATUS_ICONS[draft.status] ?? Mail;
  const isActionable = draft.status === 'draft';
  const isLoading = actionLoading === draft.id;

  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="p-4">
        {/* Header row */}
        <div
          className="flex items-start gap-2 cursor-pointer"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="mt-0.5 text-muted-foreground shrink-0">
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <StatusIcon className="h-4 w-4 shrink-0" />
              <span className="font-medium text-sm truncate">{draft.subject}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>To: {draft.to_address}</span>
              {draft.cc_address && <span>CC: {draft.cc_address}</span>}
              <Badge
                variant="outline"
                className={cn('text-xs border', STATUS_STYLES[draft.status])}
              >
                {draft.status}
              </Badge>
              {draft.source && (
                <Badge variant="secondary" className="text-xs">
                  {draft.source}
                </Badge>
              )}
              <span className="ml-auto">{formatRelativeTime(draft.created_at)}</span>
            </div>
          </div>

          {/* Action buttons (inline, always visible for drafts) */}
          {isActionable && (
            <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              {onEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => onEdit(draft.id)}
                  disabled={isLoading}
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                onClick={() => onApprove(draft.id)}
                disabled={isLoading}
              >
                <Check className="h-3 w-3" />
                Approve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive"
                onClick={() => onReject(draft.id)}
                disabled={isLoading}
              >
                <X className="h-3 w-3" />
                Reject
              </Button>
            </div>
          )}
        </div>

        {/* Expanded detail — body preview */}
        {expanded && (
          <div className="mt-3 ml-6 space-y-2 border-t pt-3">
            <p className="text-sm whitespace-pre-wrap">{draft.body}</p>

            {draft.sent_at && (
              <p className="text-xs text-muted-foreground">
                Sent: {new Date(draft.sent_at).toLocaleString()}
              </p>
            )}
            {draft.approved_at && (
              <p className="text-xs text-muted-foreground">
                Approved: {new Date(draft.approved_at).toLocaleString()}
              </p>
            )}

            <p className="text-[10px] text-muted-foreground font-mono">{draft.id}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Tab selector ───────────────────────────────────────────────────────────

type Tab = 'inbound' | 'drafts' | 'threads';

// ─── Thread reconstruction helpers ──────────────────────────────────────────

interface EmailThread {
  id: string;
  subject: string;
  messages: Capture[];
  lastActivity: string;
  participants: string[];
}

function extractSender(capture: Capture): string {
  const meta = capture.source_metadata as Record<string, unknown> | undefined;
  if (meta?.from && typeof meta.from === 'string') return meta.from;
  return 'unknown';
}

function extractSubject(capture: Capture): string {
  const meta = capture.source_metadata as Record<string, unknown> | undefined;
  if (meta?.subject && typeof meta.subject === 'string') return meta.subject;
  // Fall back to first line of content
  const first = capture.content.split('\n')[0] ?? '';
  return first.replace(/^Subject:\s*/i, '').slice(0, 80) || '(no subject)';
}

function normalizeSubject(subject: string): string {
  return subject.replace(/^(Re|Fwd|Fw):\s*/gi, '').trim().toLowerCase();
}

/**
 * Groups email captures into threads by normalized subject line and message_id references.
 */
function buildThreads(captures: Capture[]): EmailThread[] {
  const threadMap = new Map<string, Capture[]>();

  for (const capture of captures) {
    const subject = extractSubject(capture);
    const key = normalizeSubject(subject);

    if (!threadMap.has(key)) {
      threadMap.set(key, []);
    }
    threadMap.get(key)!.push(capture);
  }

  const threads: EmailThread[] = [];
  for (const [, messages] of threadMap) {
    // Sort by date ascending within thread
    messages.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const participants = [...new Set(messages.map(extractSender))];
    const lastMsg = messages[messages.length - 1];

    threads.push({
      id: messages[0].id,
      subject: extractSubject(messages[0]),
      messages,
      lastActivity: lastMsg.created_at,
      participants,
    });
  }

  // Sort threads by last activity descending
  threads.sort(
    (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
  );

  return threads;
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function Email() {
  const [tab, setTab] = useState<Tab>('inbound');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Inbound tab state
  const [inboundCaptures, setInboundCaptures] = useState<Capture[]>([]);
  const [inboundTotal, setInboundTotal] = useState(0);

  // Drafts tab state
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [draftsTotal, setDraftsTotal] = useState(0);
  const [draftFilter, setDraftFilter] = useState<string>('');

  // Inbound filters
  const [senderFilter, setSenderFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Compose drawer state
  const [composeOpen, setComposeOpen] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);

  const loadInbound = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await capturesApi.list({ source: 'email', limit: 100 });
      setInboundCaptures(result.data);
      setInboundTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inbound emails');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await emailApi.list({
        status: draftFilter || undefined,
        limit: 50,
      });
      setDrafts(result.items);
      setDraftsTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drafts');
    } finally {
      setLoading(false);
    }
  }, [draftFilter]);

  useEffect(() => {
    if (tab === 'inbound' || tab === 'threads') {
      loadInbound();
    } else {
      loadDrafts();
    }
  }, [tab, loadInbound, loadDrafts]);

  // Filtered inbound captures (client-side filtering by sender and date)
  const filteredInbound = useMemo(() => {
    let items = inboundCaptures;

    if (senderFilter) {
      const lower = senderFilter.toLowerCase();
      items = items.filter((c) => {
        const sender = extractSender(c).toLowerCase();
        return sender.includes(lower);
      });
    }

    if (dateFrom) {
      const from = new Date(dateFrom).getTime();
      items = items.filter((c) => new Date(c.created_at).getTime() >= from);
    }

    if (dateTo) {
      // Include the full end day
      const to = new Date(dateTo).getTime() + 86_400_000;
      items = items.filter((c) => new Date(c.created_at).getTime() < to);
    }

    return items;
  }, [inboundCaptures, senderFilter, dateFrom, dateTo]);

  // Thread data derived from filtered inbound captures
  const threads = useMemo(() => buildThreads(filteredInbound), [filteredInbound]);

  async function handleApprove(id: string) {
    setActionLoading(id);
    setActionMsg(null);
    try {
      await emailApi.send(id);
      setActionMsg('Email approved and sent.');
      setTimeout(() => setActionMsg(null), 5000);
      loadDrafts();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(id: string) {
    setActionLoading(id);
    setActionMsg(null);
    try {
      await emailApi.reject(id);
      setActionMsg('Draft rejected.');
      setTimeout(() => setActionMsg(null), 5000);
      loadDrafts();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setActionLoading(null);
    }
  }

  function clearFilters() {
    setSenderFilter('');
    setDateFrom('');
    setDateTo('');
  }

  const hasActiveFilters = Boolean(senderFilter || dateFrom || dateTo);

  const refresh =
    tab === 'inbound' || tab === 'threads' ? loadInbound : loadDrafts;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Mail className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Email</h1>
        </div>
        <div className="flex gap-2">
          {(tab === 'inbound' || tab === 'threads') && (
            <Button
              variant={showFilters ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowFilters((v) => !v)}
              className="gap-2"
            >
              <Filter className="h-4 w-4" />
              Filters
              {hasActiveFilters && (
                <Badge variant="secondary" className="text-xs ml-1">
                  active
                </Badge>
              )}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditingDraftId(null);
              setComposeOpen(true);
            }}
            className="gap-2"
          >
            <Mail className="h-4 w-4" />
            <Pencil className="h-4 w-4" />
            Compose
          </Button>
        </div>
      </div>

      {/* Filter bar (inbound + threads) */}
      {showFilters && (tab === 'inbound' || tab === 'threads') && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <User className="h-3 w-3" />
                Sender
              </label>
              <input
                type="text"
                placeholder="Filter by sender..."
                value={senderFilter}
                onChange={(e) => setSenderFilter(e.target.value)}
                className="h-8 px-2 text-sm rounded-md border bg-background w-48"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                From
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-8 px-2 text-sm rounded-md border bg-background"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                To
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-8 px-2 text-sm rounded-md border bg-background"
              />
            </div>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="h-8 text-xs">
                Clear
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Feedback */}
      {actionMsg && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-200">
          {actionMsg}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            tab === 'inbound'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTab('inbound')}
        >
          <Inbox className="h-4 w-4" />
          Inbound
          {inboundTotal > 0 && (
            <Badge variant="secondary" className="text-xs ml-1">
              {inboundTotal}
            </Badge>
          )}
        </button>
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            tab === 'drafts'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTab('drafts')}
        >
          <MailOpen className="h-4 w-4" />
          Drafts / Outbox
          {draftsTotal > 0 && (
            <Badge variant="secondary" className="text-xs ml-1">
              {draftsTotal}
            </Badge>
          )}
        </button>
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
            tab === 'threads'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTab('threads')}
        >
          <MessageSquare className="h-4 w-4" />
          Threads
          {threads.length > 0 && (
            <Badge variant="secondary" className="text-xs ml-1">
              {threads.length}
            </Badge>
          )}
        </button>
      </div>

      {/* Tab content */}
      {tab === 'inbound' && (
        <InboundTab
          captures={filteredInbound}
          total={filteredInbound.length}
          unfilteredTotal={inboundTotal}
          loading={loading}
          hasFilters={hasActiveFilters}
        />
      )}
      {tab === 'drafts' && (
        <DraftsTab
          drafts={drafts}
          total={draftsTotal}
          loading={loading}
          filter={draftFilter}
          onFilterChange={setDraftFilter}
          onApprove={handleApprove}
          onReject={handleReject}
          onEdit={(id) => {
            setEditingDraftId(id);
            setComposeOpen(true);
          }}
          actionLoading={actionLoading}
        />
      )}
      {tab === 'threads' && (
        <ThreadsTab
          threads={threads}
          loading={loading}
          hasFilters={hasActiveFilters}
        />
      )}

      {/* Compose drawer — mounts always so transitions are smooth */}
      <EmailComposeDrawer
        open={composeOpen}
        onOpenChange={(next) => {
          setComposeOpen(next);
          if (!next) setEditingDraftId(null);
        }}
        draftId={editingDraftId}
        onSaved={() => {
          // Refresh the drafts list if we're currently looking at it.
          if (tab === 'drafts') void loadDrafts();
        }}
        onSent={() => {
          setActionMsg('Email sent.');
          setTimeout(() => setActionMsg(null), 5000);
          if (tab === 'drafts') void loadDrafts();
        }}
      />
    </div>
  );
}

// ─── Inbound tab ────────────────────────────────────────────────────────────

function InboundTab({
  captures,
  total,
  unfilteredTotal,
  loading,
  hasFilters,
}: {
  captures: Capture[];
  total: number;
  unfilteredTotal: number;
  loading: boolean;
  hasFilters: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-secondary" />
        ))}
      </div>
    );
  }

  if (captures.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
        <Inbox className="h-10 w-10 mx-auto mb-3 opacity-50" />
        {hasFilters ? (
          <>
            <p className="text-sm">No emails match the current filters.</p>
            <p className="text-xs mt-1">
              {unfilteredTotal} email{unfilteredTotal !== 1 ? 's' : ''} total.
              Try adjusting filters.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm">No inbound emails captured yet.</p>
            <p className="text-xs mt-1">
              Emails sent to brain@troy-davis.com will appear here.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {total} email{total !== 1 ? 's' : ''}
        {hasFilters && total !== unfilteredTotal
          ? ` (filtered from ${unfilteredTotal})`
          : ''}
      </p>
      <div className="space-y-2">
        {captures.map((capture) => (
          <CaptureCard key={capture.id} capture={capture} />
        ))}
      </div>
    </div>
  );
}

// ─── Drafts tab ─────────────────────────────────────────────────────────────

const DRAFT_FILTERS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Pending' },
  { value: 'sent', label: 'Sent' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
];

function DraftsTab({
  drafts,
  total,
  loading,
  filter,
  onFilterChange,
  onApprove,
  onReject,
  onEdit,
  actionLoading,
}: {
  drafts: EmailDraft[];
  total: number;
  loading: boolean;
  filter: string;
  onFilterChange: (v: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit?: (id: string) => void;
  actionLoading: string | null;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-secondary" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        {DRAFT_FILTERS.map((f) => (
          <Button
            key={f.value}
            variant={filter === f.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => onFilterChange(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <Separator />

      {drafts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          <MailOpen className="h-10 w-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No email drafts{filter ? ` with status "${filter}"` : ''}.</p>
          <p className="text-xs mt-1">
            Drafts created by skills or agents will appear here for review.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {total} draft{total !== 1 ? 's' : ''}
            {filter ? ` (filtered: ${filter})` : ''}
          </p>
          <div className="space-y-2">
            {drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                onApprove={onApprove}
                onReject={onReject}
                onEdit={onEdit}
                actionLoading={actionLoading}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Threads tab ────────────────────────────────────────────────────────────

function ThreadsTab({
  threads,
  loading,
  hasFilters,
}: {
  threads: EmailThread[];
  loading: boolean;
  hasFilters: boolean;
}) {
  const [expandedThread, setExpandedThread] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-secondary" />
        ))}
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
        <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-50" />
        {hasFilters ? (
          <>
            <p className="text-sm">No threads match the current filters.</p>
            <p className="text-xs mt-1">Try adjusting the sender or date filters.</p>
          </>
        ) : (
          <>
            <p className="text-sm">No email threads found.</p>
            <p className="text-xs mt-1">
              Threads are reconstructed from inbound emails by subject line.
              Emails sent to brain@troy-davis.com will be grouped here.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {threads.length} thread{threads.length !== 1 ? 's' : ''}
      </p>
      <div className="space-y-2">
        {threads.map((thread) => {
          const isExpanded = expandedThread === thread.id;
          const msgCount = thread.messages.length;

          return (
            <Card key={thread.id} className="hover:border-primary/50 transition-colors">
              <CardContent className="p-4">
                {/* Thread header */}
                <div
                  className="flex items-start gap-2 cursor-pointer"
                  onClick={() =>
                    setExpandedThread(isExpanded ? null : thread.id)
                  }
                >
                  <span className="mt-0.5 text-muted-foreground shrink-0">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="font-medium text-sm truncate">
                        {thread.subject}
                      </span>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {msgCount} message{msgCount !== 1 ? 's' : ''}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>
                        {thread.participants.length <= 2
                          ? thread.participants.join(', ')
                          : `${thread.participants[0]} + ${thread.participants.length - 1} others`}
                      </span>
                      <span className="ml-auto">
                        {formatRelativeTime(thread.lastActivity)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Expanded: show threaded messages */}
                {isExpanded && (
                  <div className="mt-3 ml-6 space-y-3 border-t pt-3">
                    {thread.messages.map((msg, idx) => {
                      const sender = extractSender(msg);
                      const subject = extractSubject(msg);
                      const preview =
                        msg.content.length > 200
                          ? msg.content.slice(0, 200) + '...'
                          : msg.content;

                      return (
                        <div
                          key={msg.id}
                          className={cn(
                            'rounded-md border p-3 space-y-1',
                            idx === 0 ? 'bg-muted/30' : '',
                          )}
                        >
                          <div className="flex items-center gap-2 text-xs">
                            <User className="h-3 w-3 text-muted-foreground" />
                            <span className="font-medium">{sender}</span>
                            <span className="text-muted-foreground ml-auto">
                              {new Date(msg.created_at).toLocaleString()}
                            </span>
                          </div>
                          {idx === 0 && (
                            <p className="text-xs text-muted-foreground">
                              Subject: {subject}
                            </p>
                          )}
                          <p className="text-sm whitespace-pre-wrap">{preview}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {msg.id}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
