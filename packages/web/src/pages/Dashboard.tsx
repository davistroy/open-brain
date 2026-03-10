import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Plus, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import StatsCards from '@/components/StatsCards';
import CaptureCard from '@/components/CaptureCard';
import { capturesApi, statsApi, pipelineApi } from '@/lib/api';
import type { BrainStats, Capture } from '@/lib/types';

const QUICK_CAPTURE_SOURCE = 'api' as const;
const RECENT_LIMIT = 10;

interface PipelineHealth {
  queues: Record<string, { waiting: number; active: number; failed: number }>;
}

function PipelineHealthBanner({ health }: { health: PipelineHealth }) {
  const totalFailed = Object.values(health.queues).reduce((sum, q) => sum + q.failed, 0);
  const totalActive = Object.values(health.queues).reduce((sum, q) => sum + q.active, 0);
  const totalWaiting = Object.values(health.queues).reduce((sum, q) => sum + q.waiting, 0);

  if (totalFailed === 0 && totalWaiting < 20) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
        Queue healthy — {totalActive} active, {totalWaiting} queued
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
      <AlertCircle className="h-4 w-4 shrink-0" />
      Queue: {totalFailed} jobs failed, {totalWaiting} waiting, {totalActive} active
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();

  const [stats, setStats] = useState<BrainStats | null>(null);
  const [recentCaptures, setRecentCaptures] = useState<Capture[]>([]);
  const [pipelineHealth, setPipelineHealth] = useState<PipelineHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Quick capture state
  const [quickInput, setQuickInput] = useState('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickSuccess, setQuickSuccess] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [statsData, capturesData, healthData] = await Promise.allSettled([
        statsApi.get(),
        capturesApi.list({ limit: RECENT_LIMIT }),
        pipelineApi.health(),
      ]);

      if (statsData.status === 'fulfilled') setStats(statsData.value);
      if (capturesData.status === 'fulfilled') setRecentCaptures(capturesData.value.data);
      if (healthData.status === 'fulfilled') setPipelineHealth(healthData.value);

      // Surface error only if all three failed
      if (
        statsData.status === 'rejected' &&
        capturesData.status === 'rejected' &&
        healthData.status === 'rejected'
      ) {
        setError('Failed to load dashboard data. Is the Core API running?');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleRefresh() {
    setRefreshing(true);
    load(true);
  }

  async function handleQuickCapture(e: React.FormEvent) {
    e.preventDefault();
    const content = quickInput.trim();
    if (!content) return;

    setQuickSubmitting(true);
    setQuickError(null);
    setQuickSuccess(false);

    try {
      // POST to /api/v1/captures with source=api
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
      // Reload recent captures
      capturesApi.list({ limit: RECENT_LIMIT }).then((r) => setRecentCaptures(r.data)).catch(() => {});
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : 'Capture failed');
    } finally {
      setQuickSubmitting(false);
    }
  }

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
        <h1 className="text-2xl font-bold">Dashboard</h1>
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

      {/* Pipeline health */}
      {pipelineHealth && <PipelineHealthBanner health={pipelineHealth} />}

      {/* Stats cards */}
      {stats && <StatsCards stats={stats} />}

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

      {/* Recent captures */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Recent Captures</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('/timeline')} className="text-xs">
            View all
          </Button>
        </div>

        {recentCaptures.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
            <p className="text-sm">No captures yet.</p>
            <p className="text-xs mt-1">Use the quick capture above or send a message in Slack.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recentCaptures.map((capture) => (
              <CaptureCard key={capture.id} capture={capture} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
