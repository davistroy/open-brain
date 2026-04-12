import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  AlertCircle,
  CheckCircle,
  XCircle,
  Activity,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
  Zap,
  Clock,
  GitBranch,
  Server,
  DollarSign,
  HardDrive,
  Database,
  Archive,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { systemHealthApi, skillsApi, adminApi, mcpActivityApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  Skill,
  SystemHealthSnapshot,
  QueueStatsEntry,
  SkillLastRun,
  McpActivityEntry,
  InfrastructureData,
  PipelineFlowEntry,
  ContainerHealthEntry,
  BackupLogEntry,
} from '@/lib/types';

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = 'queues' | 'flows' | 'skills' | 'infrastructure' | 'mcp';

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return 'just now';
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Convert a cron expression to a simple human-readable description.
 */
function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;

  const [minute, hour, dom, month, dow] = fields;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Every N minutes: "*/N * * * *"
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${minute.slice(2)} min`;
  }

  // Every hour: "M * * * *"
  if (minute.match(/^\d+$/) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Hourly at :${minute.padStart(2, '0')}`;
  }

  // Every N hours: "0 */N * * *"
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    return `Every ${hour.slice(2)}h`;
  }

  // Daily: "M H * * *"
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dom === '*' && month === '*' && dow === '*') {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily ${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  // Weekly: "M H * * D"
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dom === '*' && month === '*' && dow.match(/^\d$/)) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    const d = parseInt(dow, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const dayName = dayNames[d] ?? `day ${d}`;
    return `${dayName} ${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  return expr;
}

function statusColor(status: string): string {
  if (status === 'healthy') return 'text-green-500';
  if (status === 'degraded') return 'text-yellow-500';
  return 'text-red-500';
}

function statusBgColor(status: string): string {
  if (status === 'healthy') return 'bg-green-500/10 border-green-500/30';
  if (status === 'degraded') return 'bg-yellow-500/10 border-yellow-500/30';
  return 'bg-red-500/10 border-red-500/30';
}

// ─── Queues Tab ─────────────────────────────────────────────────────────────

function QueuesTab({
  queues,
  loading,
  error,
  onClearFailed,
}: {
  queues: QueueStatsEntry[];
  loading: boolean;
  error: string | null;
  onClearFailed: (queueName: string) => Promise<void>;
}) {
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

// ─── Skills Tab ─────────────────────────────────────────────────────────────

function SkillsTab({
  skills,
  skillRuns,
  loading,
  error,
  onTrigger,
}: {
  skills: Skill[];
  skillRuns: SkillLastRun[];
  loading: boolean;
  error: string | null;
  onTrigger: (name: string) => Promise<void>;
}) {
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});

  // Build a map from skill_name -> last run info
  const runMap = new Map<string, SkillLastRun>();
  for (const run of skillRuns) {
    runMap.set(run.skill_name, run);
  }

  async function handleTrigger(name: string) {
    setTriggering(name);
    try {
      await onTrigger(name);
      setTriggerMsg((m) => ({ ...m, [name]: 'Queued' }));
      setTimeout(() => setTriggerMsg((m) => { const n = { ...m }; delete n[name]; return n; }), 4000);
    } catch (err) {
      setTriggerMsg((m) => ({ ...m, [name]: err instanceof Error ? err.message : 'Failed' }));
    } finally {
      setTriggering(null);
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

  if (loading && skills.length === 0) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded bg-secondary" />)}
      </div>
    );
  }

  if (skills.length === 0) {
    return <p className="text-sm text-muted-foreground">No skills configured.</p>;
  }

  return (
    <div className="rounded-lg border bg-card divide-y">
      {skills.map((skill) => {
        const lastRun = runMap.get(skill.name);
        const lastRunAt = lastRun?.last_run_at ?? skill.last_run_at ?? skill.last_run;
        const lastStatus = skill.last_run_status ?? (lastRunAt ? 'success' : undefined);
        const duration = lastRun?.duration_ms;

        return (
          <div key={skill.name} className="px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium font-mono">{skill.name}</span>
                {lastStatus && (
                  lastStatus === 'success'
                    ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {skill.schedule && (
                  <span title={skill.schedule}>
                    {describeCron(skill.schedule)}
                  </span>
                )}
                {lastRunAt && (
                  <span>Last: {relativeTime(lastRunAt)}</span>
                )}
                {duration != null && (
                  <span>Duration: {formatDuration(duration)}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {triggerMsg[skill.name] && (
                <span className="text-xs text-muted-foreground">{triggerMsg[skill.name]}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={triggering === skill.name}
                onClick={() => handleTrigger(skill.name)}
                className="text-xs h-7"
              >
                {triggering === skill.name ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    Queuing...
                  </>
                ) : (
                  'Run now'
                )}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Flows Tab ─────────────────────────────────────────────────────────────

function stageStatusIcon(status: string) {
  if (status === 'complete' || status === 'completed' || status === 'success') {
    return <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />;
  }
  if (status === 'failed' || status === 'error') {
    return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  }
  if (status === 'processing' || status === 'active') {
    return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />;
  }
  return <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
}

function pipelineStatusBadge(status: string) {
  const variant = status === 'complete' ? 'default'
    : status === 'failed' ? 'destructive'
    : status === 'processing' ? 'secondary'
    : 'outline';
  return <Badge variant={variant} className="text-[10px] px-1.5 py-0">{status}</Badge>;
}

function FlowsTab({
  flows,
  loading,
  error,
}: {
  flows: PipelineFlowEntry[];
  loading: boolean;
  error: string | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (loading && flows.length === 0) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <div key={i} className="h-16 animate-pulse rounded bg-secondary" />)}
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No pipeline flows found.</p>
        <p className="text-xs mt-1">Captures processed through the pipeline will appear here.</p>
      </div>
    );
  }

  // Split into active (processing/pending) and recent completed
  const active = flows.filter(f => f.pipeline_status === 'processing' || f.pipeline_status === 'pending');
  const completed = flows.filter(f => f.pipeline_status !== 'processing' && f.pipeline_status !== 'pending');

  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Active Flows ({active.length})</h3>
          <FlowList flows={active} expanded={expanded} onToggle={toggleExpand} />
        </div>
      )}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-2">
          Recent Flows ({completed.length})
        </h3>
        <FlowList flows={completed} expanded={expanded} onToggle={toggleExpand} />
      </div>
    </div>
  );
}

function FlowList({
  flows,
  expanded,
  onToggle,
}: {
  flows: PipelineFlowEntry[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-card divide-y">
      {flows.map((flow) => {
        const isExpanded = expanded.has(flow.capture_id);
        const totalDuration = flow.stages.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
        const failedStages = flow.stages.filter(s => s.status === 'failed' || s.status === 'error');

        return (
          <div key={flow.capture_id} className="px-4 py-3">
            <button
              className="w-full flex items-center justify-between gap-3 text-left"
              onClick={() => onToggle(flow.capture_id)}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-xs font-mono text-muted-foreground truncate">
                  {flow.capture_id.slice(0, 8)}
                </span>
                {pipelineStatusBadge(flow.pipeline_status)}
                {failedStages.length > 0 && (
                  <span className="text-xs text-destructive">{failedStages.length} failed</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                <span>{flow.stages.length} stages</span>
                {totalDuration > 0 && <span>{formatDuration(totalDuration)}</span>}
                <span>{relativeTime(flow.created_at)}</span>
              </div>
            </button>

            {isExpanded && (
              <div className="mt-3 ml-6">
                {flow.trace_id && (
                  <div className="text-xs text-muted-foreground mb-2">
                    <span className="font-medium text-foreground">Trace:</span>{' '}
                    <span className="font-mono">{flow.trace_id.slice(0, 12)}...</span>
                  </div>
                )}

                {/* Tree view of stages */}
                <div className="space-y-1">
                  {flow.stages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No stage events recorded.</p>
                  ) : (
                    flow.stages.map((stage, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-xs">
                        <div className="w-4 flex justify-center text-muted-foreground/40">
                          {idx < flow.stages.length - 1 ? '|' : 'L'}
                        </div>
                        {stageStatusIcon(stage.status)}
                        <span className="font-mono font-medium">{stage.stage}</span>
                        <Badge
                          variant={stage.status === 'complete' || stage.status === 'completed' || stage.status === 'success' ? 'default' :
                            stage.status === 'failed' || stage.status === 'error' ? 'destructive' : 'outline'}
                          className="text-[9px] px-1 py-0"
                        >
                          {stage.status}
                        </Badge>
                        {stage.duration_ms != null && (
                          <span className="text-muted-foreground">{formatDuration(stage.duration_ms)}</span>
                        )}
                        {stage.started_at && (
                          <span className="text-muted-foreground/60">{relativeTime(stage.started_at)}</span>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {/* Show errors */}
                {failedStages.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {failedStages.map((s, i) => (
                      <div key={i} className="text-xs bg-destructive/5 border border-destructive/20 rounded px-2 py-1">
                        <span className="font-mono font-medium text-destructive">{s.stage}:</span>{' '}
                        <span className="text-destructive/80">{s.error ?? 'Unknown error'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Infrastructure Tab ────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes === 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function InfrastructureTab({
  data,
  loading,
  error,
}: {
  data: InfrastructureData | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[...Array(3)].map((_, i) => <div key={i} className="h-48 animate-pulse rounded-lg bg-secondary" />)}
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">No infrastructure data available.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Container Health */}
      <ContainerHealthSection entries={data.container_health} />

      {/* Backups */}
      <BackupsSection entries={data.backups} />

      {/* Cost Summary */}
      <CostSection cost={data.cost} />
    </div>
  );
}

function ContainerHealthSection({ entries }: { entries: ContainerHealthEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            <CardTitle className="text-sm">Container Health</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No health check data recorded yet.</p>
        </CardContent>
      </Card>
    );
  }

  // Group by container name, show latest status for each
  const latestByContainer = new Map<string, ContainerHealthEntry>();
  for (const entry of entries) {
    if (!latestByContainer.has(entry.container_name)) {
      latestByContainer.set(entry.container_name, entry);
    }
  }

  const containers = Array.from(latestByContainer.values());

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4" />
          <CardTitle className="text-sm">Container Health</CardTitle>
          <Badge variant="outline" className="text-[10px] ml-auto">{containers.length} containers</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {containers.map((c) => (
            <div key={c.container_name} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                {c.healthy ? (
                  <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                )}
                <span className="text-sm font-mono">{c.container_name}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {c.response_ms != null && <span>{c.response_ms}ms</span>}
                <span>{relativeTime(c.timestamp)}</span>
                {c.error && (
                  <span className="text-destructive truncate max-w-[200px]" title={c.error}>{c.error}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BackupsSection({ entries }: { entries: BackupLogEntry[] }) {
  // Group by type, show latest
  const typeIcons: Record<string, React.ReactNode> = {
    database: <Database className="h-3.5 w-3.5 text-blue-500" />,
    redis: <HardDrive className="h-3.5 w-3.5 text-orange-500" />,
    wiki: <Archive className="h-3.5 w-3.5 text-purple-500" />,
  };

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            <CardTitle className="text-sm">Recent Backups</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No backup records found.</p>
        </CardContent>
      </Card>
    );
  }

  // Show latest 10
  const recent = entries.slice(0, 10);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4" />
          <CardTitle className="text-sm">Recent Backups</CardTitle>
          <Badge variant="outline" className="text-[10px] ml-auto">{entries.length} total</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {recent.map((b) => (
            <div key={b.id} className="flex items-center justify-between py-2 first:pt-0 last:pb-0 gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {typeIcons[b.backup_type] ?? <Archive className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="text-sm capitalize">{b.backup_type}</span>
                {b.status === 'success' ? (
                  <CheckCircle className="h-3 w-3 text-green-500" />
                ) : (
                  <XCircle className="h-3 w-3 text-destructive" />
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                {b.size_bytes != null && <span>{formatBytes(b.size_bytes)}</span>}
                {b.duration_seconds != null && <span>{b.duration_seconds}s</span>}
                {b.pruned_count > 0 && <span className="text-orange-500">{b.pruned_count} pruned</span>}
                <span>{relativeTime(b.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CostSection({ cost }: { cost: InfrastructureData['cost'] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          <CardTitle className="text-sm">LLM Cost Breakdown ({cost.month})</CardTitle>
          <Badge variant="outline" className="text-[10px] ml-auto font-mono">
            ${cost.total_usd.toFixed(2)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {cost.by_model.length === 0 ? (
          <p className="text-sm text-muted-foreground">No LLM usage this month.</p>
        ) : (
          <div className="divide-y">
            {cost.by_model.map((m) => (
              <div key={m.model} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono">{m.model}</span>
                  <span className="text-xs text-muted-foreground">{m.call_count.toLocaleString()} calls</span>
                </div>
                <span className="text-sm font-mono tabular-nums">${m.cost_usd.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── MCP Activity Tab ───────────────────────────────────────────────────────

function McpActivityTab({
  entries,
  total,
  loading,
  error,
  onLoadMore,
  hasMore,
}: {
  entries: McpActivityEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (loading && entries.length === 0) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded bg-secondary" />)}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        <Wrench className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No MCP activity recorded yet.</p>
        <p className="text-xs mt-1">MCP tool calls will appear here as they happen.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{total} total entries</p>
      <div className="rounded-lg border bg-card divide-y">
        {entries.map((entry) => {
          const isExpanded = expanded.has(entry.id);
          return (
            <div key={entry.id} className="px-4 py-3">
              <button
                className="w-full flex items-center justify-between gap-3 text-left"
                onClick={() => toggleExpand(entry.id)}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <Badge variant="outline" className="text-xs font-mono shrink-0">
                    {entry.tool_name}
                  </Badge>
                  {entry.client_id && (
                    <span className="text-xs text-muted-foreground truncate">
                      {entry.client_id.length > 12 ? entry.client_id.slice(0, 12) + '...' : entry.client_id}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                  {entry.duration_ms != null && (
                    <span>{formatDuration(entry.duration_ms)}</span>
                  )}
                  <span>{relativeTime(entry.timestamp)}</span>
                </div>
              </button>

              {isExpanded && (
                <div className="mt-2 ml-6 space-y-2">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Timestamp:</span>{' '}
                    {new Date(entry.timestamp).toLocaleString()}
                  </div>
                  {entry.client_id && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Client:</span> {entry.client_id}
                    </div>
                  )}
                  {entry.parameters && Object.keys(entry.parameters).length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-1">Parameters:</p>
                      <pre className="text-xs bg-secondary/50 rounded p-2 overflow-x-auto max-h-40">
                        {JSON.stringify(entry.parameters, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.result_summary && (
                    <div>
                      <p className="text-xs font-medium mb-1">Result:</p>
                      <pre className="text-xs bg-secondary/50 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
                        {entry.result_summary}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button size="sm" variant="outline" onClick={onLoadMore} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Loading...
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main System Page ───────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'queues', label: 'Queues', icon: Activity },
  { key: 'flows', label: 'Flows', icon: GitBranch },
  { key: 'skills', label: 'Skills', icon: Zap },
  { key: 'infrastructure', label: 'Infrastructure', icon: Server },
  { key: 'mcp', label: 'MCP Activity', icon: Wrench },
];

const MCP_PAGE_SIZE = 30;

export default function System() {
  const [activeTab, setActiveTab] = useState<Tab>('queues');
  const [refreshing, setRefreshing] = useState(false);

  // Queues state
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null);
  const [queuesLoading, setQueuesLoading] = useState(true);
  const [queuesError, setQueuesError] = useState<string | null>(null);

  // Skills state
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  // Flows state
  const [flows, setFlows] = useState<PipelineFlowEntry[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(true);
  const [flowsError, setFlowsError] = useState<string | null>(null);

  // Infrastructure state
  const [infraData, setInfraData] = useState<InfrastructureData | null>(null);
  const [infraLoading, setInfraLoading] = useState(true);
  const [infraError, setInfraError] = useState<string | null>(null);

  // MCP activity state
  const [mcpEntries, setMcpEntries] = useState<McpActivityEntry[]>([]);
  const [mcpTotal, setMcpTotal] = useState(0);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpError, setMcpError] = useState<string | null>(null);

  // ── Data loaders ──

  const loadQueues = useCallback(async () => {
    setQueuesError(null);
    try {
      const data = await systemHealthApi.fullSnapshot();
      setSnapshot(data);
    } catch (err) {
      setQueuesError(err instanceof Error ? err.message : 'Failed to load system health');
    } finally {
      setQueuesLoading(false);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    setSkillsError(null);
    try {
      const res = await skillsApi.list();
      setSkills(res.data);
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const loadFlows = useCallback(async () => {
    setFlowsError(null);
    try {
      const res = await systemHealthApi.flows(30);
      setFlows(res.flows);
    } catch (err) {
      setFlowsError(err instanceof Error ? err.message : 'Failed to load pipeline flows');
    } finally {
      setFlowsLoading(false);
    }
  }, []);

  const loadInfrastructure = useCallback(async () => {
    setInfraError(null);
    try {
      const data = await systemHealthApi.infrastructure();
      setInfraData(data);
    } catch (err) {
      setInfraError(err instanceof Error ? err.message : 'Failed to load infrastructure data');
    } finally {
      setInfraLoading(false);
    }
  }, []);

  const loadMcpActivity = useCallback(async (append = false) => {
    setMcpError(null);
    setMcpLoading(true);
    try {
      const offset = append ? mcpEntries.length : 0;
      const res = await mcpActivityApi.list({ limit: MCP_PAGE_SIZE, offset });
      if (append) {
        setMcpEntries((prev) => [...prev, ...res.items]);
      } else {
        setMcpEntries(res.items);
      }
      setMcpTotal(res.total);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to load MCP activity');
    } finally {
      setMcpLoading(false);
    }
  }, [mcpEntries.length]);

  // ── Initial load ──

  useEffect(() => {
    loadQueues();
    loadSkills();
    loadFlows();
    loadInfrastructure();
    loadMcpActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Refresh ──

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.allSettled([
      loadQueues(),
      loadSkills(),
      loadFlows(),
      loadInfrastructure(),
      loadMcpActivity(),
    ]);
    setRefreshing(false);
  }

  // ── Queue actions ──

  async function handleClearFailed(queueName: string) {
    await adminApi.clearQueue(queueName, 'failed');
    // Reload queue stats after clearing
    await loadQueues();
  }

  // ── Skill actions ──

  async function handleTriggerSkill(name: string) {
    await skillsApi.trigger(name);
  }

  // ── MCP load more ──

  function handleLoadMoreMcp() {
    loadMcpActivity(true);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System</h1>
          <p className="text-sm text-muted-foreground">
            Queues, pipeline flows, skills, infrastructure, and MCP activity
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={cn('h-4 w-4 mr-1', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Overview strip from snapshot */}
      {snapshot && (
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
      )}

      <Separator />

      {/* Tab navigation */}
      <div className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
                isActive
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'queues' && (
        <QueuesTab
          queues={snapshot?.queues ?? []}
          loading={queuesLoading}
          error={queuesError}
          onClearFailed={handleClearFailed}
        />
      )}

      {activeTab === 'flows' && (
        <FlowsTab
          flows={flows}
          loading={flowsLoading}
          error={flowsError}
        />
      )}

      {activeTab === 'skills' && (
        <SkillsTab
          skills={skills}
          skillRuns={snapshot?.skill_last_runs ?? []}
          loading={skillsLoading}
          error={skillsError}
          onTrigger={handleTriggerSkill}
        />
      )}

      {activeTab === 'infrastructure' && (
        <InfrastructureTab
          data={infraData}
          loading={infraLoading}
          error={infraError}
        />
      )}

      {activeTab === 'mcp' && (
        <McpActivityTab
          entries={mcpEntries}
          total={mcpTotal}
          loading={mcpLoading}
          error={mcpError}
          onLoadMore={handleLoadMoreMcp}
          hasMore={mcpEntries.length < mcpTotal}
        />
      )}
    </div>
  );
}
