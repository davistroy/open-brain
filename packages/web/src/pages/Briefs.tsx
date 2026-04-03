import { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, Play, ChevronDown, ChevronUp, AlertCircle, AlertTriangle, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { skillsApi } from '@/lib/api';
import type { Skill, SkillLog } from '@/lib/types';

const BRIEF_SKILL = 'weekly-brief';

// ─── Date helpers ────────────────────────────────────────────────────────────

interface Preset {
  id: string;
  label: string;
  days: number | 'compute';
}

const PRESETS: Preset[] = [
  { id: 'this-week', label: 'This Week', days: 'compute' },
  { id: 'this-month', label: 'This Month', days: 'compute' },
  { id: '7d', label: '7d', days: 7 },
  { id: '14d', label: '14d', days: 14 },
  { id: '30d', label: '30d', days: 30 },
  { id: '60d', label: '60d', days: 60 },
];

/** Compute the day count for dynamic presets based on today's date. */
function computePresetDays(presetId: string): number {
  const now = new Date();
  if (presetId === 'this-week') {
    const dow = now.getDay(); // 0=Sun, 1=Mon, …, 6=Sat
    return Math.max(1, dow === 0 ? 1 : dow + 1);
  }
  if (presetId === 'this-month') {
    return Math.max(1, now.getDate());
  }
  const preset = PRESETS.find((p) => p.id === presetId);
  return typeof preset?.days === 'number' ? preset.days : 7;
}

/** Format a date range label given a day count from today. */
function formatDateRange(days: number): { from: string; to: string; label: string } {
  const now = new Date();
  const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fromStr = fmt(start);
  const toStr = fmt(now);
  return {
    from: fromStr,
    to: toStr,
    label: `${fromStr} — ${toStr} (${days} day${days !== 1 ? 's' : ''})`,
  };
}

// ─── RunBriefPanel ───────────────────────────────────────────────────────────

interface RunBriefPanelProps {
  onTrigger: (windowDays: number) => Promise<void>;
  onCancel: () => void;
  triggering: boolean;
}

function RunBriefPanel({ onTrigger, onCancel, triggering }: RunBriefPanelProps) {
  const [selectedPreset, setSelectedPreset] = useState<string | null>('7d');
  const [customValue, setCustomValue] = useState('');

  const effectiveDays = useMemo(() => {
    if (customValue.trim() !== '') {
      const parsed = parseInt(customValue, 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    if (selectedPreset) return computePresetDays(selectedPreset);
    return 7;
  }, [selectedPreset, customValue]);

  const validationError = useMemo(() => {
    if (customValue.trim() !== '') {
      const parsed = parseInt(customValue, 10);
      if (Number.isNaN(parsed)) return 'Enter a valid number';
      if (parsed < 1) return 'Must be at least 1 day';
      if (parsed > 365) return 'Maximum 365 days';
    }
    if (effectiveDays !== null && effectiveDays < 1) return 'Must be at least 1 day';
    return null;
  }, [customValue, effectiveDays]);

  const dateRange = useMemo(() => {
    if (effectiveDays === null || effectiveDays < 1) return null;
    return formatDateRange(effectiveDays);
  }, [effectiveDays]);

  function handlePresetClick(presetId: string) {
    setSelectedPreset(presetId);
    setCustomValue('');
  }

  function handleCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustomValue(e.target.value);
    setSelectedPreset(null);
  }

  function handleGenerate() {
    if (effectiveDays !== null && !validationError) {
      onTrigger(effectiveDays);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      {/* Title + live date preview */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Generate Brief</h3>
        {dateRange && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            {dateRange.label}
          </span>
        )}
      </div>

      {/* Preset buttons */}
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            variant={selectedPreset === p.id ? 'default' : 'outline'}
            size="sm"
            onClick={() => handlePresetClick(p.id)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">or</span>
        <Separator className="flex-1" />
      </div>

      {/* Custom input */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Custom:</span>
        <Input
          type="number"
          className="w-20"
          min={1}
          max={365}
          placeholder="days"
          value={customValue}
          onChange={handleCustomChange}
        />
        <span className="text-sm text-muted-foreground">days</span>
      </div>

      {/* Warning for large windows */}
      {effectiveDays !== null && effectiveDays >= 90 && !validationError && (
        <div className="flex items-center gap-2 text-xs text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Large window — may take longer and use more AI tokens.
        </div>
      )}

      {/* Validation error */}
      {validationError && (
        <p className="text-xs text-destructive">{validationError}</p>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={!!validationError || effectiveDays === null || triggering}
          className="gap-1.5"
        >
          <Play className="h-4 w-4" />
          {triggering ? 'Queuing…' : 'Generate Brief'}
        </Button>
      </div>
    </div>
  );
}

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
  const brief = log.result ? parseBriefResult(log.result as Record<string, unknown>) : null;
  const runDate = new Date(log.started_at).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  const durationMs = log.duration_ms ?? (log.completed_at && log.started_at ? new Date(log.completed_at).getTime() - new Date(log.started_at).getTime() : undefined);
  const durationSec = durationMs ? (durationMs / 1000).toFixed(1) : null;

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
            <Badge variant={(log.status === 'success' || log.status === 'completed') ? 'default' : 'destructive'} className="text-xs">
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

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          <Separator />
          {brief ? (
            <>
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
            </>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              {log.output || 'No brief content available.'}
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
  const [showPanel, setShowPanel] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillsRes, logsRes] = await Promise.all([
        skillsApi.list(),
        skillsApi.getLogs(BRIEF_SKILL),
      ]);
      const skillsList = skillsRes.data ?? skillsRes;
      const found = (skillsList as Skill[]).find((s: Skill) => s.name === BRIEF_SKILL) ?? null;
      setSkill(found);
      const logsList = logsRes.data ?? logsRes;
      setLogs(logsList as SkillLog[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load briefs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTrigger(windowDays: number) {
    setTriggering(true);
    setTriggerMsg(null);
    try {
      await skillsApi.trigger(BRIEF_SKILL, { windowDays });
      setTriggerMsg(`Brief queued (${windowDays} day${windowDays !== 1 ? 's' : ''}) — check back in a few minutes.`);
      setShowPanel(false);
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
          {(skill?.next_run_at ?? skill?.next_run) && (
            <p className="text-sm text-muted-foreground mt-0.5">
              Next scheduled: {new Date((skill!.next_run_at ?? skill!.next_run)!).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowPanel((v) => !v)} disabled={triggering} className="gap-2">
            <Play className="h-4 w-4" />
            Run Now
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

      {/* Run Brief config panel */}
      {showPanel && (
        <RunBriefPanel
          onTrigger={handleTrigger}
          onCancel={() => setShowPanel(false)}
          triggering={triggering}
        />
      )}

      {/* Skill status */}
      {skill && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>Schedule: <span className="font-mono text-foreground">{skill.schedule}</span></span>
          {(skill.last_run_at ?? skill.last_run) && (
            <>
              <span>|</span>
              <span>
                Last run: {new Date((skill.last_run_at ?? skill.last_run)!).toLocaleString()}
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
