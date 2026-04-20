import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import CaptureCard from '@/components/CaptureCard';
import { capturesApi } from '@/lib/api';
import type { Capture, CaptureType, BrainView, CaptureSource } from '@/lib/types';
import { cn } from '@/lib/utils';

// --- Brain view color mapping ---
const VIEW_COLORS: Record<BrainView, string> = {
  career: 'bg-blue-100 text-blue-800 border-blue-200',
  personal: 'bg-green-100 text-green-800 border-green-200',
  technical: 'bg-purple-100 text-purple-800 border-purple-200',
  'work-internal': 'bg-orange-100 text-orange-800 border-orange-200',
  client: 'bg-red-100 text-red-800 border-red-200',
};

const VIEW_DOT: Record<BrainView, string> = {
  career: 'bg-blue-500',
  personal: 'bg-green-500',
  technical: 'bg-purple-500',
  'work-internal': 'bg-orange-500',
  client: 'bg-red-500',
};

const CAPTURE_TYPES: CaptureType[] = [
  'decision', 'idea', 'observation', 'task', 'win', 'blocker', 'question', 'reflection',
];

const BRAIN_VIEWS: BrainView[] = ['career', 'personal', 'technical', 'work-internal', 'client'];

const CAPTURE_SOURCES: CaptureSource[] = [
  'slack', 'voice', 'api', 'document', 'mcp', 'email', 'file', 'consolidation', 'system',
];

const PAGE_SIZE = 25;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function dateGroupKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TimelineEntry({ capture }: { capture: Capture }) {
  const dot = VIEW_DOT[capture.brain_view] ?? 'bg-gray-400';
  return (
    <div className="flex gap-3 py-2">
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center pt-3 shrink-0">
        <div className={cn('h-2.5 w-2.5 rounded-full', dot)} />
        <div className="flex-1 w-px bg-border mt-1" />
      </div>
      {/* Shared CaptureCard */}
      <div className="flex-1 min-w-0">
        <CaptureCard capture={capture} />
      </div>
    </div>
  );
}

export default function Timeline() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [captureType, setCaptureType] = useState<CaptureType | ''>('');
  const [brainView, setBrainView] = useState<BrainView | ''>('');
  const [captureSource, setCaptureSource] = useState<CaptureSource | ''>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchCaptures = useCallback(async (reset = false) => {
    const currentOffset = reset ? 0 : offset;
    if (!reset && currentOffset > 0 && currentOffset >= total && total > 0) return;

    reset ? setLoading(true) : setLoadingMore(true);
    setError(null);

    try {
      const params: Parameters<typeof capturesApi.list>[0] = {
        limit: PAGE_SIZE,
        offset: currentOffset,
      };
      if (brainView) params.brain_view = brainView;
      if (captureSource) params.source = captureSource;

      const res = await capturesApi.list(params);

      // Apply client-side type filter (API doesn't support capture_type filter directly)
      let filtered = res.data;
      if (captureType) filtered = filtered.filter((c) => c.capture_type === captureType);
      if (startDate) filtered = filtered.filter((c) => c.created_at >= startDate);
      if (endDate) filtered = filtered.filter((c) => c.created_at <= endDate + 'T23:59:59');

      setCaptures((prev) => reset ? filtered : [...prev, ...filtered]);
      setTotal(res.total);
      setOffset(currentOffset + PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load captures');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [brainView, captureType, captureSource, startDate, endDate, offset, total]);

  // Initial load and filter resets
  useEffect(() => {
    setOffset(0);
    setCaptures([]);
    setTotal(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brainView, captureType, captureSource, startDate, endDate]);

  useEffect(() => {
    if (offset === 0) {
      fetchCaptures(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMore && !loading && captures.length < total) {
          fetchCaptures(false);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [fetchCaptures, loadingMore, loading, captures.length, total]);

  // Group captures by date
  const groups: Array<{ date: string; label: string; items: Capture[] }> = [];
  for (const c of captures) {
    const key = dateGroupKey(c.created_at);
    const last = groups[groups.length - 1];
    if (last && last.date === key) {
      last.items.push(c);
    } else {
      groups.push({ date: key, label: formatDate(c.created_at), items: [c] });
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Timeline</h1>
        {total > 0 && (
          <span className="text-sm text-muted-foreground">
            {total.toLocaleString()} capture{total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-5">
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={captureType}
          onChange={(e) => setCaptureType(e.target.value as CaptureType | '')}
        >
          <option value="">All types</option>
          {CAPTURE_TYPES.map((t) => (
            <option key={t} value={t} className="capitalize">{t}</option>
          ))}
        </select>

        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={brainView}
          onChange={(e) => setBrainView(e.target.value as BrainView | '')}
        >
          <option value="">All views</option>
          {BRAIN_VIEWS.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>

        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={captureSource}
          onChange={(e) => setCaptureSource(e.target.value as CaptureSource | '')}
        >
          <option value="">All sources</option>
          {CAPTURE_SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <Input
          type="date"
          className="h-9 w-auto"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          placeholder="From"
        />
        <Input
          type="date"
          className="h-9 w-auto"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          placeholder="To"
        />

        {(captureType || brainView || captureSource || startDate || endDate) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCaptureType('');
              setBrainView('');
              setCaptureSource('');
              setStartDate('');
              setEndDate('');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* View legend */}
      <div className="flex flex-wrap gap-3 mb-5">
        {BRAIN_VIEWS.map((v) => (
          <button
            key={v}
            onClick={() => setBrainView(brainView === v ? '' : v)}
            className={cn(
              'flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border transition-colors',
              brainView === v
                ? VIEW_COLORS[v]
                : 'border-border text-muted-foreground hover:border-primary',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', VIEW_DOT[v])} />
            {v}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="text-destructive text-sm py-8 text-center">{error}</div>
      )}

      {!loading && !error && captures.length === 0 && (
        <p className="text-muted-foreground text-center py-12">No captures found.</p>
      )}

      {!loading && groups.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.date}>
              <div className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm py-1 mb-1">
                <h2 className="text-sm font-semibold text-muted-foreground">{group.label}</h2>
              </div>
              <div className="pl-1">
                {group.items.map((c) => (
                  <TimelineEntry key={c.id} capture={c} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Infinite scroll sentinel */}
      <div ref={bottomRef} className="h-4" />

      {loadingMore && (
        <div className="py-4 text-center text-sm text-muted-foreground animate-pulse">
          Loading more...
        </div>
      )}

      {!loadingMore && captures.length > 0 && captures.length >= total && (
        <p className="py-4 text-center text-xs text-muted-foreground">
          All {total.toLocaleString()} captures loaded
        </p>
      )}
    </div>
  );
}
