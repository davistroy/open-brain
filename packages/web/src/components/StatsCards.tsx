import { Brain, AlertTriangle, Clock, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { BrainStats, BrainView, CaptureType } from '@/lib/types';

const VIEW_LABELS: Record<BrainView, string> = {
  career: 'Career',
  personal: 'Personal',
  technical: 'Technical',
  'work-internal': 'Work',
  client: 'Client',
};

const TYPE_LABELS: Record<CaptureType, string> = {
  decision: 'Decision',
  idea: 'Idea',
  observation: 'Observation',
  task: 'Task',
  win: 'Win',
  blocker: 'Blocker',
  question: 'Question',
  reflection: 'Reflection',
};

const TYPE_COLORS: Record<CaptureType, string> = {
  decision: 'bg-blue-500',
  idea: 'bg-purple-500',
  observation: 'bg-gray-400',
  task: 'bg-yellow-500',
  win: 'bg-green-500',
  blocker: 'bg-red-500',
  question: 'bg-orange-500',
  reflection: 'bg-indigo-500',
};

interface StatsCardsProps {
  stats: BrainStats;
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

export default function StatsCards({ stats }: StatsCardsProps) {
  const totalCaptures = stats.total_captures;
  const maxByType = Math.max(...Object.values(stats.by_type), 1);
  const maxByView = Math.max(...Object.values(stats.by_view), 1);

  const healthStatus =
    stats.pipeline_health.failed_jobs === 0
      ? 'healthy'
      : stats.pipeline_health.failed_jobs < 5
      ? 'degraded'
      : 'critical';

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Total captures */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Brain className="h-4 w-4" />
            Total Captures
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{totalCaptures.toLocaleString()}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {(stats.embeddings_coverage * 100).toFixed(0)}% embedded
          </p>
        </CardContent>
      </Card>

      {/* Pipeline health */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Pipeline Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className={cn(
              'text-xl font-bold capitalize',
              healthStatus === 'healthy'
                ? 'text-green-600'
                : healthStatus === 'degraded'
                ? 'text-yellow-600'
                : 'text-red-600',
            )}
          >
            {healthStatus}
          </div>
          <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
            <p>Queue: {stats.pipeline_health.queue_depth} pending</p>
            <p>Failed: {stats.pipeline_health.failed_jobs} jobs</p>
            <p>Avg: {stats.pipeline_health.avg_processing_ms}ms</p>
          </div>
        </CardContent>
      </Card>

      {/* By type */}
      <Card className="sm:col-span-2 lg:col-span-1">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            By Type
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {(Object.entries(stats.by_type) as [CaptureType, number][])
            .sort(([, a], [, b]) => b - a)
            .slice(0, 6)
            .map(([type, count]) => (
              <BarRow
                key={type}
                label={TYPE_LABELS[type] ?? type}
                value={count}
                max={maxByType}
                color={TYPE_COLORS[type] ?? 'bg-gray-400'}
              />
            ))}
        </CardContent>
      </Card>

      {/* By view */}
      <Card className="sm:col-span-2 lg:col-span-1">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            By View
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {(Object.entries(stats.by_view) as [BrainView, number][])
            .sort(([, a], [, b]) => b - a)
            .map(([view, count]) => (
              <BarRow
                key={view}
                label={VIEW_LABELS[view] ?? view}
                value={count}
                max={maxByView}
                color="bg-primary"
              />
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
