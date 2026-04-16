import { useState } from 'react';
import {
  AlertCircle,
  XCircle,
  Zap,
  Clock,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { QueueStatsEntry } from '@/lib/types';
import { statusBgColor } from './helpers';

export interface QueuesTabProps {
  queues: QueueStatsEntry[];
  loading: boolean;
  error: string | null;
  onClearFailed: (queueName: string) => Promise<void>;
}

export function QueuesTab({
  queues,
  loading,
  error,
  onClearFailed,
}: QueuesTabProps) {
  const [clearing, setClearing] = useState<string | null>(null);
  const [clearResult, setClearResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  async function handleClear(name: string) {
    setClearing(name);
    try {
      const res = await onClearFailed(name);
      void res;
      setClearResult((prev) => ({ ...prev, [name]: { ok: true, msg: 'Cleared' } }));
      setTimeout(() => setClearResult((prev) => { const n = { ...prev }; delete n[name]; return n; }), 4000);
    } catch (err) {
      setClearResult((prev) => ({
        ...prev,
        [name]: { ok: false, msg: err instanceof Error ? err.message : 'Failed' },
      }));
    } finally {
      setClearing(null);
    }
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (loading && queues.length === 0) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-lg bg-secondary" />
        ))}
      </div>
    );
  }

  if (queues.length === 0) {
    return <p className="text-sm text-muted-foreground">No queues found.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {queues.map((q) => {
        const total = q.waiting + q.active;
        return (
          <Card key={q.name} className={cn('transition-colors', statusBgColor(q.status))}>
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium capitalize">
                  {q.name.replace(/-/g, ' ')}
                </CardTitle>
                <Badge
                  variant={q.status === 'healthy' ? 'default' : q.status === 'degraded' ? 'secondary' : 'destructive'}
                  className="text-[10px] px-1.5 py-0"
                >
                  {q.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="grid grid-cols-2 gap-y-1.5 text-sm">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">Waiting</span>
                </div>
                <span className="text-right font-mono tabular-nums">{q.waiting}</span>

                <div className="flex items-center gap-1.5">
                  <Zap className="h-3 w-3 text-blue-500" />
                  <span className="text-muted-foreground">Active</span>
                </div>
                <span className={cn('text-right font-mono tabular-nums', q.active > 0 && 'text-blue-600 dark:text-blue-400')}>
                  {q.active}
                </span>

                <div className="flex items-center gap-1.5">
                  <XCircle className="h-3 w-3 text-destructive" />
                  <span className="text-muted-foreground">Failed</span>
                </div>
                <span className={cn('text-right font-mono tabular-nums', q.failed > 0 && 'text-destructive')}>
                  {q.failed}
                </span>

                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground/50" />
                  <span className="text-muted-foreground">Delayed</span>
                </div>
                <span className="text-right font-mono tabular-nums text-muted-foreground">{q.delayed}</span>
              </div>

              {/* Clear failed button */}
              {q.failed > 0 && (
                <div className="mt-3 flex items-center justify-end gap-2">
                  {clearResult[q.name] && (
                    <span className={cn('text-xs', clearResult[q.name].ok ? 'text-green-600 dark:text-green-400' : 'text-destructive')}>
                      {clearResult[q.name].msg}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={clearing === q.name}
                    onClick={() => handleClear(q.name)}
                  >
                    {clearing === q.name ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : null}
                    Clear failed
                  </Button>
                </div>
              )}

              {total === 0 && q.failed === 0 && (
                <p className="mt-2 text-xs text-green-600 dark:text-green-400">Idle</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
