import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { emailApi, capturesApi } from '@/lib/api';
import CaptureCard from '@/components/CaptureCard';
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
  actionLoading: string | null;
}

function DraftCard({ draft, onApprove, onReject, actionLoading }: DraftCardProps) {
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

type Tab = 'inbound' | 'drafts';

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

  const loadInbound = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await capturesApi.list({ source: 'email', limit: 50 });
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
    if (tab === 'inbound') {
      loadInbound();
    } else {
      loadDrafts();
    }
  }, [tab, loadInbound, loadDrafts]);

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

  const refresh = tab === 'inbound' ? loadInbound : loadDrafts;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Mail className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Email</h1>
        </div>
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
      </div>

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
          Drafts
          {draftsTotal > 0 && (
            <Badge variant="secondary" className="text-xs ml-1">
              {draftsTotal}
            </Badge>
          )}
        </button>
      </div>

      {/* Tab content */}
      {tab === 'inbound' && (
        <InboundTab
          captures={inboundCaptures}
          total={inboundTotal}
          loading={loading}
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
          actionLoading={actionLoading}
        />
      )}
    </div>
  );
}

// ─── Inbound tab ────────────────────────────────────────────────────────────

function InboundTab({
  captures,
  total,
  loading,
}: {
  captures: Capture[];
  total: number;
  loading: boolean;
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
        <p className="text-sm">No inbound emails captured yet.</p>
        <p className="text-xs mt-1">
          Emails sent to brain@troy-davis.com will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {total} inbound email{total !== 1 ? 's' : ''} captured
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
  actionLoading,
}: {
  drafts: EmailDraft[];
  total: number;
  loading: boolean;
  filter: string;
  onFilterChange: (v: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
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
                actionLoading={actionLoading}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
