import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertCircle, Lightbulb, TrendingDown, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { intelligenceApi } from '@/lib/api';
import type { IntelligenceSummary } from '@/lib/api';
import ConnectionsCard from '@/components/ConnectionsCard';
import DriftCard from '@/components/DriftCard';

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function Intelligence() {
  const [summary, setSummary] = useState<IntelligenceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [triggeringSkill, setTriggeringSkill] = useState<string | null>(null);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await intelligenceApi.summary();
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load intelligence data');
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

  async function handleTrigger(skill: 'daily-connections' | 'drift-monitor') {
    setTriggeringSkill(skill);
    setTriggerMsg(null);
    try {
      await intelligenceApi.trigger(skill);
      const label = skill === 'daily-connections' ? 'Connections analysis' : 'Drift monitor';
      setTriggerMsg(`${label} queued -- check back in a few minutes.`);
      setTimeout(() => setTriggerMsg(null), 8000);
    } catch (err) {
      setTriggerMsg(err instanceof Error ? err.message : 'Trigger failed');
    } finally {
      setTriggeringSkill(null);
    }
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Intelligence</h1>
        <div className="animate-pulse space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-48 rounded-lg bg-secondary" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const connectionsEntry = summary?.connections ?? null;
  const driftEntry = summary?.drift ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Intelligence</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Daily connections and drift monitoring insights
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Trigger feedback */}
      {triggerMsg && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {triggerMsg}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <Separator />

      {/* Intelligence cards grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Connections card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-amber-500" />
                <CardTitle className="text-lg">Connections</CardTitle>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleTrigger('daily-connections')}
                disabled={triggeringSkill === 'daily-connections'}
                className="gap-1.5 text-xs"
              >
                <Play className="h-3 w-3" />
                {triggeringSkill === 'daily-connections' ? 'Queuing...' : 'Run'}
              </Button>
            </div>
            <CardDescription>
              Cross-domain patterns across recent captures
            </CardDescription>
          </CardHeader>
          <CardContent>
            {connectionsEntry ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="default" className="text-xs">
                    {connectionsEntry.duration_ms
                      ? `${(connectionsEntry.duration_ms / 1000).toFixed(1)}s`
                      : 'completed'}
                  </Badge>
                  <span>{formatRelativeTime(connectionsEntry.created_at)}</span>
                </div>
                <ConnectionsCard entry={connectionsEntry} />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
                <p className="text-sm">No connections analysis yet.</p>
                <p className="text-xs mt-1">Click "Run" to generate your first analysis.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Drift card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-red-500" />
                <CardTitle className="text-lg">Drift Monitor</CardTitle>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleTrigger('drift-monitor')}
                disabled={triggeringSkill === 'drift-monitor'}
                className="gap-1.5 text-xs"
              >
                <Play className="h-3 w-3" />
                {triggeringSkill === 'drift-monitor' ? 'Queuing...' : 'Run'}
              </Button>
            </div>
            <CardDescription>
              Silent bets, declining entities, stale commitments
            </CardDescription>
          </CardHeader>
          <CardContent>
            {driftEntry ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="default" className="text-xs">
                    {driftEntry.duration_ms
                      ? `${(driftEntry.duration_ms / 1000).toFixed(1)}s`
                      : 'completed'}
                  </Badge>
                  <span>{formatRelativeTime(driftEntry.created_at)}</span>
                </div>
                <DriftCard entry={driftEntry} />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
                <p className="text-sm">No drift analysis yet.</p>
                <p className="text-xs mt-1">Click "Run" to check for drifting items.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
