import { AlertCircle, Cpu } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { AIRoutingResponse } from '@/lib/types';

export interface AIRoutingSectionProps {
  routing: AIRoutingResponse | null;
  loading: boolean;
  error: string | null;
}

export function AIRoutingSection({ routing, loading, error }: AIRoutingSectionProps) {
  if (loading && !routing) {
    return (
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">AI Routing</h2>
        </div>
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-secondary" />)}
        </div>
      </section>
    );
  }

  const budgetPct = routing?.budget
    ? Math.min(100, (routing.budget.month_total_usd / routing.budget.hard_limit_usd) * 100)
    : 0;
  const budgetColor = budgetPct > 80 ? 'bg-destructive' : budgetPct > 60 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">AI Routing</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {routing && (
        <>
          {/* Model routing table */}
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-x-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b bg-muted/30">
              <span>Task</span>
              <span>Model</span>
              <span className="text-right">Client</span>
              <span className="text-right">Calls</span>
            </div>
            {routing.models.map((entry) => (
              <div
                key={entry.task}
                className="grid grid-cols-[1fr_1fr_auto_auto] gap-x-4 px-4 py-2.5 text-sm border-b last:border-b-0"
              >
                <span className="font-medium capitalize">{entry.task}</span>
                <span className="font-mono text-xs text-muted-foreground truncate">{entry.model}</span>
                <Badge variant={entry.client === 'anthropic' ? 'default' : 'secondary'} className="text-xs justify-self-end">
                  {entry.client}
                </Badge>
                <span className="text-xs text-muted-foreground text-right tabular-nums">
                  {entry.month_calls > 0 ? entry.month_calls.toLocaleString() : '\u2014'}
                </span>
              </div>
            ))}
          </div>

          {/* Monthly budget progress */}
          <div className="rounded-lg border bg-card px-4 py-3 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Monthly Spend</span>
              <span className="font-mono text-xs">
                ${routing.budget.month_total_usd.toFixed(2)} / ${routing.budget.hard_limit_usd.toFixed(0)} budget
              </span>
            </div>
            <div className="h-2 rounded-full bg-secondary overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${budgetColor}`}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Soft limit: ${routing.budget.soft_limit_usd}</span>
              <span>Hard limit: ${routing.budget.hard_limit_usd}</span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
