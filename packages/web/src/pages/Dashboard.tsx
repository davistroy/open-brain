import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  RefreshCw,
  Plus,
  AlertCircle,
  HelpCircle,
  Filter,
  Bell,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import StatsCards from '@/components/StatsCards';
import ActivityFeedItemComponent from '@/components/ActivityFeedItem';
import { FinancialPulseCard } from '@/components/FinancialPulseCard';
import { statsApi, pipelineApi, adminApi, intelligenceApi, activityApi } from '@/lib/api';
import { sseClient } from '@/lib/sse';
import type { AdminBanner } from '@/lib/api';
import type { BrainStats, ActivityFeedItem } from '@/lib/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUICK_CAPTURE_SOURCE = 'api' as const;
const FEED_PAGE_SIZE = 30;
const LAST_VISIT_KEY = 'open-brain-last-visit';

const ACTIVITY_TYPES = [
  { value: '', label: 'All types' },
  { value: 'capture', label: 'Captures' },
  { value: 'skill', label: 'Skills' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'entity', label: 'Entities' },
  { value: 'wiki', label: 'Wiki' },
  { value: 'mcp', label: 'MCP' },
  { value: 'system', label: 'System' },
];

const BRAIN_VIEWS: { value: string; label: string }[] = [
  { value: '', label: 'All views' },
  { value: 'career', label: 'Career' },
  { value: 'personal', label: 'Personal' },
  { value: 'technical', label: 'Technical' },
  { value: 'work-internal', label: 'Work' },
  { value: 'client', label: 'Client' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLastVisit(): string | null {
  try {
    return localStorage.getItem(LAST_VISIT_KEY);
  } catch {
    return null;
  }
}

function setLastVisit(): void {
  try {
    localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
  } catch {
    // localStorage unavailable — ignore
  }
}

interface PipelineHealth {
  queues: Record<string, { waiting: number; active: number; failed: number }>;
}

function PipelineHealthBanner({ health }: { health: PipelineHealth }) {
  const totalFailed = Object.values(health.queues).reduce((sum, q) => sum + q.failed, 0);
  const totalActive = Object.values(health.queues).reduce((sum, q) => sum + q.active, 0);
  const totalWaiting = Object.values(health.queues).reduce((sum, q) => sum + q.waiting, 0);

  if (totalFailed === 0 && totalWaiting < 20) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
        Queue healthy — {totalActive} active, {totalWaiting} queued
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300">
      <AlertCircle className="h-4 w-4 shrink-0" />
      Queue: {totalFailed} jobs failed, {totalWaiting} waiting, {totalActive} active
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // --- Core data ---
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [pipelineHealth, setPipelineHealth] = useState<PipelineHealth | null>(null);
  const [adminBanner, setAdminBanner] = useState<AdminBanner | null>(null);
  const [unresolvedQuestions, setUnresolvedQuestions] = useState<Array<{ id: string; content: string; brain_view: string; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // --- Activity feed ---
  const [feedItems, setFeedItems] = useState<ActivityFeedItem[]>([]);
  const [feedTotal, setFeedTotal] = useState(0);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedOffset, setFeedOffset] = useState(0);

  // --- "Since you've been away" ---
  const [awayCount, setAwayCount] = useState(0);
  const lastVisitRef = useRef<string | null>(getLastVisit());

  // --- Filters from URL ---
  const typeFilter = searchParams.get('type') ?? '';
  const viewFilter = searchParams.get('view') ?? '';

  // --- Quick capture ---
  const [quickInput, setQuickInput] = useState('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickSuccess, setQuickSuccess] = useState(false);

  // --- Filter handlers ---
  function updateFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    setSearchParams(next, { replace: true });
    setFeedOffset(0);
  }

  // --- Load stats + pipeline (non-feed data) ---
  const loadStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [statsData, healthData, bannerData, questionsData] = await Promise.allSettled([
        statsApi.get(),
        pipelineApi.health(),
        adminApi.getBanner(),
        intelligenceApi.unresolvedQuestions(5),
      ]);

      if (statsData.status === 'fulfilled') setStats(statsData.value);
      if (healthData.status === 'fulfilled') setPipelineHealth(healthData.value);
      if (bannerData.status === 'fulfilled') setAdminBanner(bannerData.value.banner);
      if (questionsData.status === 'fulfilled') setUnresolvedQuestions(questionsData.value.questions);

      if (
        statsData.status === 'rejected' &&
        healthData.status === 'rejected'
      ) {
        setError('Failed to load dashboard data. Is the Core API running?');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // --- Load activity feed ---
  const loadFeed = useCallback(async (offset = 0) => {
    setFeedLoading(true);
    try {
      const params: Record<string, string | number> = { limit: FEED_PAGE_SIZE, offset };
      if (typeFilter) params.type = typeFilter;
      if (viewFilter) params.view = viewFilter;

      const res = await activityApi.list(params as Parameters<typeof activityApi.list>[0]);
      if (offset === 0) {
        setFeedItems(res.items);
      } else {
        setFeedItems((prev) => [...prev, ...res.items]);
      }
      setFeedTotal(res.total);
      setFeedOffset(offset);
    } catch {
      // Feed error is non-fatal — stats still visible
    } finally {
      setFeedLoading(false);
    }
  }, [typeFilter, viewFilter]);

  // --- "Since you've been away" count ---
  useEffect(() => {
    const lastVisit = lastVisitRef.current;
    if (!lastVisit) return;

    activityApi.countSince(lastVisit).then((count) => {
      setAwayCount(count);
    }).catch(() => {
      // Non-fatal
    });
  }, []);

  // --- Initial load ---
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    loadFeed(0);
  }, [loadFeed]);

  // --- Record last visit on mount ---
  useEffect(() => {
    // Set the last visit timestamp when user views the dashboard
    // Use a small delay so the "since you've been away" count is computed
    // with the previous visit timestamp
    const timer = setTimeout(() => setLastVisit(), 2000);
    return () => clearTimeout(timer);
  }, []);

  // --- SSE for real-time updates ---
  useEffect(() => {
    sseClient.start();
    const unsub = sseClient.on((event) => {
      // Map SSE events to activity feed items for real-time display
      if (event.type === 'capture_created' || event.type === 'pipeline_complete' || event.type === 'skill_complete') {
        // Prepend a synthetic activity item and bump count
        const newItem: ActivityFeedItem = {
          id: `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: event.type === 'capture_created' ? 'capture' :
                event.type === 'pipeline_complete' ? 'pipeline' : 'skill',
          subtype: event.type === 'capture_created' ? 'created' :
                   event.type === 'pipeline_complete' ? 'complete' : 'completed',
          timestamp: new Date().toISOString(),
          summary: (event.data.summary as string) ?? `${event.type.replace(/_/g, ' ')}`,
          view: (event.data.brain_view as string) ?? (event.data.view as string) ?? null,
          detail: event.data,
          source_id: (event.data.id as string) ?? null,
          created_at: new Date().toISOString(),
        };

        // Only prepend if it matches current filters
        const matchesType = !typeFilter || newItem.type === typeFilter;
        const matchesView = !viewFilter || newItem.view === viewFilter;
        if (matchesType && matchesView) {
          setFeedItems((prev) => [newItem, ...prev]);
          setFeedTotal((prev) => prev + 1);
        }
      }
    });

    return () => {
      unsub();
    };
  }, [typeFilter, viewFilter]);

  // --- Also subscribe to the dedicated activity SSE stream ---
  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;

    try {
      es = new EventSource('/api/v1/activity/feed/stream');

      es.addEventListener('activity', (event: MessageEvent) => {
        if (closed) return;
        try {
          const data = JSON.parse(event.data) as ActivityFeedItem;
          // Only prepend if it matches current filters
          const matchesType = !typeFilter || data.type === typeFilter;
          const matchesView = !viewFilter || data.view === viewFilter;
          if (matchesType && matchesView) {
            setFeedItems((prev) => {
              // Deduplicate by id
              if (prev.some((item) => item.id === data.id)) return prev;
              return [data, ...prev];
            });
            setFeedTotal((prev) => prev + 1);
          }
        } catch {
          // Ignore parse errors
        }
      });

      es.onerror = () => {
        // Non-fatal — the paginated feed still works
        es?.close();
        es = null;
      };
    } catch {
      // EventSource not available or endpoint not deployed yet
    }

    return () => {
      closed = true;
      es?.close();
    };
  }, [typeFilter, viewFilter]);

  // --- Refresh handler ---
  function handleRefresh() {
    setRefreshing(true);
    loadStats(true);
    loadFeed(0);
  }

  // --- Quick capture ---
  async function handleQuickCapture(e: React.FormEvent) {
    e.preventDefault();
    const content = quickInput.trim();
    if (!content) return;

    setQuickSubmitting(true);
    setQuickError(null);
    setQuickSuccess(false);

    try {
      await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/v1/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          source: QUICK_CAPTURE_SOURCE,
          capture_type: 'observation',
          brain_view: 'personal',
        }),
      }).then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      });

      setQuickInput('');
      setQuickSuccess(true);
      setTimeout(() => setQuickSuccess(false), 3000);
      // Reload feed to show the new capture
      loadFeed(0);
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : 'Capture failed');
    } finally {
      setQuickSubmitting(false);
    }
  }

  // --- Navigate on item click ---
  function handleItemClick(item: ActivityFeedItem) {
    if (!item.source_id) return;

    switch (item.type) {
      case 'capture':
        // Navigate to timeline with the capture highlighted
        navigate(`/timeline`);
        break;
      case 'entity':
        navigate(`/entities/${item.source_id}`);
        break;
      case 'skill':
        navigate('/intelligence');
        break;
      case 'wiki':
        navigate('/wiki');
        break;
      default:
        // pipeline, mcp, system — no specific detail view
        break;
    }
  }

  // --- Load more handler ---
  function handleLoadMore() {
    loadFeed(feedOffset + FEED_PAGE_SIZE);
  }

  const hasMore = feedItems.length < feedTotal;

  // --- Render ---

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="animate-pulse space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 rounded-lg bg-secondary" />
            ))}
          </div>
          <div className="h-64 rounded-lg bg-secondary" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          {awayCount > 0 && (
            <Badge variant="default" className="gap-1">
              <Bell className="h-3 w-3" />
              {awayCount} new
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Global error */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Admin banner */}
      {adminBanner && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
          adminBanner.level === 'success' ? 'border-green-200 bg-green-50 text-green-800' :
          adminBanner.level === 'warning' ? 'border-yellow-200 bg-yellow-50 text-yellow-800' :
          'border-blue-200 bg-blue-50 text-blue-800'
        }`}>
          <span className="font-medium">{adminBanner.message}</span>
          <span className="ml-auto text-xs opacity-60">{new Date(adminBanner.created_at).toLocaleDateString()}</span>
        </div>
      )}

      {/* Pipeline health */}
      {pipelineHealth && <PipelineHealthBanner health={pipelineHealth} />}

      {/* Financial Pulse */}
      <FinancialPulseCard />

      {/* Stats cards */}
      {stats && <StatsCards stats={stats} />}

      {/* Open Questions widget */}
      {unresolvedQuestions.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-amber-500" />
              Open Questions
              <span className="text-xs font-normal text-muted-foreground">({unresolvedQuestions.length})</span>
            </h2>
            <Button variant="ghost" size="sm" onClick={() => navigate('/search?q=type:question')} className="text-xs">
              View all
            </Button>
          </div>
          <ul className="space-y-2">
            {unresolvedQuestions.slice(0, 5).map((q) => (
              <li key={q.id} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="shrink-0 mt-0.5 text-amber-400">?</span>
                <span className="line-clamp-2">
                  {q.content.length > 100 ? `${q.content.slice(0, 100)}...` : q.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Separator />

      {/* Quick capture */}
      <div>
        <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Quick Capture
        </h2>
        <form onSubmit={handleQuickCapture} className="flex gap-2">
          <Input
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            placeholder="Capture a thought, decision, or idea..."
            disabled={quickSubmitting}
            className="flex-1"
          />
          <Button type="submit" disabled={quickSubmitting || !quickInput.trim()} className="shrink-0">
            {quickSubmitting ? 'Saving...' : 'Capture'}
          </Button>
        </form>
        {quickSuccess && (
          <p className="text-sm text-green-600 mt-1.5">Captured successfully — pipeline will classify and embed shortly.</p>
        )}
        {quickError && (
          <p className="text-sm text-destructive mt-1.5">{quickError}</p>
        )}
      </div>

      <Separator />

      {/* Activity Feed */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Activity Feed
            <span className="text-xs font-normal text-muted-foreground">
              ({feedTotal.toLocaleString()} total)
            </span>
          </h2>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-2 mb-4">
          <select
            value={typeFilter}
            onChange={(e) => updateFilter('type', e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {ACTIVITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>

          <select
            value={viewFilter}
            onChange={(e) => updateFilter('view', e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {BRAIN_VIEWS.map((v) => (
              <option key={v.value} value={v.value}>{v.label}</option>
            ))}
          </select>

          {(typeFilter || viewFilter) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchParams({}, { replace: true });
                setFeedOffset(0);
              }}
              className="text-xs"
            >
              Clear filters
            </Button>
          )}
        </div>

        {/* Feed items */}
        {feedItems.length === 0 && !feedLoading ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
            <p className="text-sm">No activity yet.</p>
            <p className="text-xs mt-1">Activity will appear here as captures, skills, and pipeline events occur.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {feedItems.map((item, index) => {
              // Items are "new" if they arrived after the user's last visit
              const isNew = lastVisitRef.current
                ? new Date(item.timestamp) > new Date(lastVisitRef.current)
                : false;
              return (
                <ActivityFeedItemComponent
                  key={item.id ?? index}
                  item={item}
                  onClick={handleItemClick}
                  isNew={isNew}
                />
              );
            })}
          </div>
        )}

        {/* Load more */}
        {hasMore && (
          <div className="mt-4 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadMore}
              disabled={feedLoading}
            >
              {feedLoading ? 'Loading...' : `Load more (${feedTotal - feedItems.length} remaining)`}
            </Button>
          </div>
        )}

        {feedLoading && feedItems.length === 0 && (
          <div className="animate-pulse space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 rounded-lg bg-secondary" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
