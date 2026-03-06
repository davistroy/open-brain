import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Play, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { skillsApi } from '@/lib/api';
import type { Skill, SkillLog } from '@/lib/types';

const BRIEF_SKILL = 'weekly_brief';

interface BriefContent {
  headline?: string;
  wins?: string[];
  blockers?: string[];
  risks?: string[];
  open_loops?: string[];
  next_week_focus?: string[];
  avoided_decisions?: string[];
  drift_alerts?: string[];
  connections?: string[];
}

function parseBriefResult(result: Record<string, unknown>): BriefContent {
  return {
    headline: result.headline as string | undefined,
    wins: result.wins as string[] | undefined,
    blockers: result.blockers as string[] | undefined,
    risks: result.risks as string[] | undefined,
    open_loops: result.open_loops as string[] | undefined,
    next_week_focus: result.next_week_focus as string[] | undefined,
    avoided_decisions: result.avoided_decisions as string[] | undefined,
    drift_alerts: result.drift_alerts as string[] | undefined,
    connections: result.connections as string[] | undefined,
  };
}

function StringList({ items, label }: { items?: string[]; label: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">{label}</h4>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm flex gap-2">
            <span className="text-muted-foreground shrink-0">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BriefCard({ log }: { log: SkillLog }) {
  const [expanded, setExpanded] = useState(false);
  const brief = log.result ? parseBriefResult(log.result) : null;
  const runDate = new Date(log.started_at).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  const durationSec = log.duration_ms ? (log.duration_ms / 1000).toFixed(1) : null;

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        className="w-full text-left px-4 py-3 flex items-start justify-between gap-3 hover:bg-accent/50 transition-colors rounded-lg"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium">{runDate}</span>
            <Badge variant={log.status === 'success' ? 'default' : 'destructive'} className="text-xs">
              {log.status}
            </Badge>
            {durationSec && (
              <span className="text-xs text-muted-foreground">{durationSec}s</span>
            )}
          </div>
          {brief?.headline && (
            <p className="text-sm text-muted-foreground line-clamp-2">{brief.headline}</p>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
        )}
      </button>

      {expanded && brief && (
        <div className="px-4 pb-4 space-y-4">
          <Separator />
          {brief.headline && (
            <div>
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">Headline</h4>
              <p className="text-sm">{brief.headline}</p>
            </div>
          )}
          <StringList items={brief.wins} label="Wins" />
          <StringList items={brief.blockers} label="Blockers" />
          <StringList items={brief.risks} label="Risks" />
          <StringList items={brief.open_loops} label="Open Loops" />
          <StringList items={brief.next_week_focus} label="Next Week Focus" />
          <StringList items={brief.avoided_decisions} label="Avoided Decisions" />
          <StringList items={brief.drift_alerts} label="Drift Alerts" />
          <StringList items={brief.connections} label="Connections" />
          {log.model_used && (
            <p className="text-xs text-muted-foreground">
              Model: {log.model_used}
              {log.input_tokens && log.output_tokens
                ? ` — ${log.input_tokens.toLocaleString()} in / ${log.output_tokens.toLocaleString()} out`
                : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Briefs() {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [logs, setLogs] = useState<SkillLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillsRes, logsRes] = await Promise.all([
        skillsApi.list(),
        skillsApi.getLogs(BRIEF_SKILL),
      ]);
      const found = skillsRes.data.find((s) => s.name === BRIEF_SKILL) ?? null;
      setSkill(found);
      setLogs(logsRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load briefs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTrigger() {
    setTriggering(true);
    setTriggerMsg(null);
    try {
      await skillsApi.trigger(BRIEF_SKILL);
      setTriggerMsg('Brief queued — check back in a few minutes.');
      setTimeout(() => setTriggerMsg(null), 8000);
    } catch (err) {
      setTriggerMsg(err instanceof Error ? err.message : 'Trigger failed');
    } finally {
      setTriggering(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Weekly Briefs</h1>
          {skill?.next_run_at && (
            <p className="text-sm text-muted-foreground mt-0.5">
              Next scheduled: {new Date(skill.next_run_at).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={handleTrigger} disabled={triggering} className="gap-2">
            <Play className="h-4 w-4" />
            {triggering ? 'Queuing...' : 'Run Now'}
          </Button>
        </div>
      </div>

      {/* Feedback */}
      {triggerMsg && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {triggerMsg}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Skill status */}
      {skill && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>Schedule: <span className="font-mono text-foreground">{skill.schedule}</span></span>
          {skill.last_run_at && (
            <>
              <span>|</span>
              <span>
                Last run: {new Date(skill.last_run_at).toLocaleString()}
                {skill.last_run_status && (
                  <Badge
                    variant={skill.last_run_status === 'success' ? 'default' : 'destructive'}
                    className="ml-2 text-xs"
                  >
                    {skill.last_run_status}
                  </Badge>
                )}
              </span>
            </>
          )}
        </div>
      )}

      <Separator />

      {/* Brief history */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-secondary" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          <p className="text-sm">No briefs generated yet.</p>
          <p className="text-xs mt-1">Click "Run Now" to generate your first weekly brief.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => (
            <BriefCard key={log.id} log={log} />
          ))}
        </div>
      )}
    </div>
  );
}
