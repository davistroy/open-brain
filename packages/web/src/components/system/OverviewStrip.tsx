import { cn } from '@/lib/utils';
import type { SystemHealthSnapshot } from '@/lib/types';
import { statusColor } from './helpers';

export interface OverviewStripProps {
  snapshot: SystemHealthSnapshot;
}

export function OverviewStrip({ snapshot }: OverviewStripProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div className="rounded-lg border bg-card px-3 py-2">
        <p className="text-xs text-muted-foreground">Status</p>
        <p className={cn('text-sm font-medium capitalize', statusColor(snapshot.status))}>
          {snapshot.status}
        </p>
      </div>
      <div className="rounded-lg border bg-card px-3 py-2">
        <p className="text-xs text-muted-foreground">Redis Memory</p>
        <p className="text-sm font-medium font-mono">
          {(snapshot.redis_memory.used_bytes / 1024 / 1024).toFixed(1)} MB
          {snapshot.redis_memory.max_bytes > 0 && (
            <span className="text-muted-foreground text-xs ml-1">
              ({(snapshot.redis_memory.used_pct * 100).toFixed(0)}%)
            </span>
          )}
        </p>
      </div>
      <div className="rounded-lg border bg-card px-3 py-2">
        <p className="text-xs text-muted-foreground">LLM Spend ({snapshot.monthly_spend.month})</p>
        <p className="text-sm font-medium font-mono">
          ${snapshot.monthly_spend.total_usd.toFixed(2)}
          <span className="text-muted-foreground text-xs ml-1">
            (${snapshot.monthly_spend.non_claude_usd.toFixed(2)} non-sub)
          </span>
        </p>
      </div>
      <div className="rounded-lg border bg-card px-3 py-2">
        <p className="text-xs text-muted-foreground">Uptime</p>
        <p className="text-sm font-medium">
          {snapshot.uptime_s >= 3600
            ? `${Math.floor(snapshot.uptime_s / 3600)}h ${Math.floor((snapshot.uptime_s % 3600) / 60)}m`
            : `${Math.floor(snapshot.uptime_s / 60)}m`}
        </p>
      </div>
    </div>
  );
}
