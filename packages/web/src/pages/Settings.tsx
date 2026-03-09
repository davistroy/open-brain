import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, Trash2, AlertCircle, CheckCircle, XCircle, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { skillsApi, triggersApi, pipelineApi, adminApi } from '@/lib/api';
import type { Skill, Trigger } from '@/lib/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SystemHealth {
  version?: string;
  uptime_s?: number;
  services?: Record<string, { status: 'up' | 'down' | 'degraded'; latency_ms?: number; models_available?: string[] }>;
  queues?: Record<string, { waiting: number; active: number; failed: number }>;
}

interface HealthResponse {
  status: string;
  version?: string;
  uptime_s?: number;
  services?: Record<string, { status: 'up' | 'down' | 'degraded'; latency_ms?: number; models_available?: string[] }>;
}

const BASE = import.meta.env.VITE_API_URL ?? '';

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── System Health section ────────────────────────────────────────────────────

function StatusDot({ status }: { status: 'up' | 'down' | 'degraded' | undefined }) {
  if (status === 'up') return <span className="inline-block w-2 h-2 rounded-full bg-green-500" />;
  if (status === 'degraded') return <span className="inline-block w-2 h-2 rounded-full bg-yellow-500" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-red-500" />;
}

function SystemHealthSection({ health, loading, error }: { health: SystemHealth | null; loading: boolean; error: string | null }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">System Health</h2>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && !health && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-secondary" />)}
        </div>
      )}

      {health && (
        <div className="rounded-lg border bg-card divide-y">
          {/* Version / uptime */}
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono">{health.version ?? '—'}</span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Uptime</span>
            <span>{formatUptime(health.uptime_s)}</span>
          </div>

          {/* Connected services */}
          {health.services && Object.entries(health.services).map(([name, svc]) => (
            <div key={name} className="px-4 py-3 flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <StatusDot status={svc.status} />
                <span className="capitalize">{name}</span>
              </div>
              <div className="flex items-center gap-3 text-muted-foreground">
                {svc.latency_ms !== undefined && <span>{svc.latency_ms}ms</span>}
                {svc.models_available && svc.models_available.length > 0 && (
                  <span className="text-xs">{svc.models_available.slice(0, 3).join(', ')}{svc.models_available.length > 3 ? '…' : ''}</span>
                )}
              </div>
            </div>
          ))}

          {/* Queue health */}
          {health.queues && Object.entries(health.queues).map(([name, q]) => (
            <div key={name} className="px-4 py-3 flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="capitalize">{name.replace(/-/g, ' ')} queue</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {q.waiting > 0 && <span>{q.waiting} waiting</span>}
                {q.active > 0 && <span className="text-blue-600">{q.active} active</span>}
                {q.failed > 0 && <span className="text-destructive">{q.failed} failed</span>}
                {q.waiting === 0 && q.active === 0 && q.failed === 0 && <span className="text-green-600">idle</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Skills section ───────────────────────────────────────────────────────────

function SkillsSection({ skills, loading, error, onTrigger }: {
  skills: Skill[];
  loading: boolean;
  error: string | null;
  onTrigger: (name: string) => Promise<void>;
}) {
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});

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

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Skills</h2>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && skills.length === 0 ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills configured.</p>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {skills.map((skill) => (
            <div key={skill.name} className="px-4 py-3 flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium font-mono">{skill.name}</span>
                  {(skill.last_run_status ?? (skill.last_run ? 'success' : undefined)) && (
                    (skill.last_run_status ?? 'success') === 'success'
                      ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 space-x-2">
                  <span>Schedule: <span className="font-mono">{skill.schedule}</span></span>
                  {(skill.last_run_at ?? skill.last_run) && (
                    <span>Last: {new Date((skill.last_run_at ?? skill.last_run)!).toLocaleString()}</span>
                  )}
                  {(skill.next_run_at ?? skill.next_run) && (
                    <span>Next: {new Date((skill.next_run_at ?? skill.next_run)!).toLocaleString()}</span>
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
                  className="text-xs"
                >
                  {triggering === skill.name ? 'Queuing...' : 'Run now'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Triggers section ─────────────────────────────────────────────────────────

function TriggersSection({ triggers, loading, error, onAdd, onDelete }: {
  triggers: Trigger[];
  loading: boolean;
  error: string | null;
  onAdd: (name: string, queryText: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [queryText, setQueryText] = useState('');
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !queryText.trim()) return;
    setAddSubmitting(true);
    setAddError(null);
    try {
      await onAdd(name.trim(), queryText.trim());
      setName('');
      setQueryText('');
      setAdding(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add trigger');
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await onDelete(id);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Semantic Triggers</h2>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {adding && (
        <form onSubmit={handleAdd} className="rounded-lg border bg-card p-4 space-y-3">
          <h3 className="text-sm font-medium">New Trigger</h3>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. client-risk-mentions)"
            required
          />
          <Input
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Semantic query (e.g. client escalation risk blowup)"
            required
          />
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={addSubmitting || !name.trim() || !queryText.trim()}>
              {addSubmitting ? 'Adding...' : 'Add Trigger'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {loading && triggers.length === 0 ? (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : triggers.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <p className="text-sm">No triggers configured.</p>
          <p className="text-xs mt-1">Triggers fire a Pushover notification when a new capture matches a semantic query.</p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {triggers.map((trigger) => (
            <div key={trigger.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{trigger.name}</span>
                  <Badge variant={(trigger.is_active ?? trigger.enabled) ? 'default' : 'secondary'} className="text-xs">
                    {(trigger.is_active ?? trigger.enabled) ? 'active' : 'inactive'}
                  </Badge>
                  {trigger.delivery_channel && (
                    <Badge variant="outline" className="text-xs capitalize">{trigger.delivery_channel}</Badge>
                  )}
                </div>
                {trigger.query_text && (
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{trigger.query_text}</p>
                )}
                <div className="text-xs text-muted-foreground mt-0.5 space-x-2">
                  {trigger.threshold !== undefined && <span>Threshold: {trigger.threshold}</span>}
                  {trigger.cooldown_minutes !== undefined && <span>Cooldown: {trigger.cooldown_minutes}m</span>}
                  {trigger.fire_count !== undefined && <span>Fired: {trigger.fire_count}x</span>}
                  {trigger.last_fired_at && (
                    <span>Last: {new Date(trigger.last_fired_at).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive shrink-0"
                disabled={deleting === trigger.id}
                onClick={() => handleDelete(trigger.id)}
                aria-label={`Delete trigger ${trigger.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Danger Zone section ──────────────────────────────────────────────────────

const CONFIRM_PHRASE = 'WIPE ALL DATA';

function DangerZoneSection() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [wiping, setWiping] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const confirmed = confirmText === CONFIRM_PHRASE;

  function handleOpen() {
    setOpen(true);
    setConfirmText('');
    setResult(null);
  }

  function handleClose() {
    setOpen(false);
    setConfirmText('');
  }

  async function handleWipe() {
    setWiping(true);
    setResult(null);
    try {
      const res = await adminApi.resetData();
      setResult({
        success: true,
        message: `Wiped ${res.cleared.length} tables. The brain is empty — ready for real data.`,
      });
      handleClose();
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : 'Wipe failed' });
    } finally {
      setWiping(false);
    }
  }

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-destructive">Danger Zone</h2>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Wipe All Data</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permanently deletes all captures, entities, sessions, briefs, bets, and AI audit logs.
                Schema, migration history, and semantic triggers are preserved. Cannot be undone.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleOpen}
              className="shrink-0 gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Wipe All Data
            </Button>
          </div>
          {result && (
            <div className={`flex items-center gap-2 rounded px-3 py-2 text-sm border ${
              result.success
                ? 'bg-green-50 text-green-800 border-green-200'
                : 'bg-destructive/10 text-destructive border-destructive/30'
            }`}>
              {result.success
                ? <CheckCircle className="h-4 w-4 shrink-0" />
                : <AlertCircle className="h-4 w-4 shrink-0" />}
              {result.message}
            </div>
          )}
        </div>
      </section>

      {/* Confirmation modal — rendered at root level to avoid layout clipping */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-destructive/10 p-2 shrink-0">
                <AlertCircle className="h-5 w-5 text-destructive" />
              </div>
              <h3 className="text-base font-semibold">Wipe All Data?</h3>
            </div>

            <p className="text-sm text-muted-foreground">The following will be <strong>permanently deleted</strong>:</p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>All captures and embeddings</li>
              <li>All entities and relationships</li>
              <li>All governance sessions and messages</li>
              <li>All weekly briefs (skills log)</li>
              <li>All AI audit logs and bets</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              <strong>Preserved:</strong> semantic triggers, schema, migration history.
            </p>

            <div className="space-y-1.5">
              <p className="text-xs font-medium">
                Type{' '}
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">{CONFIRM_PHRASE}</span>
                {' '}to confirm:
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                className="font-mono"
                autoFocus
                onKeyDown={(e) => e.key === 'Escape' && handleClose()}
              />
            </div>

            <div className="flex gap-2 justify-end pt-1">
              <Button variant="ghost" size="sm" onClick={handleClose} disabled={wiping}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!confirmed || wiping}
                onClick={handleWipe}
              >
                {wiping ? 'Wiping...' : 'Confirm Wipe'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Settings() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(true);
  const [triggersError, setTriggersError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);

  const loadHealth = useCallback(async () => {
    setHealthError(null);
    try {
      const [healthRes, queueRes] = await Promise.allSettled([
        apiFetch<HealthResponse>('/api/v1/health'),
        pipelineApi.health(),
      ]);
      const merged: SystemHealth = {};
      if (healthRes.status === 'fulfilled') {
        Object.assign(merged, {
          version: healthRes.value.version,
          uptime_s: healthRes.value.uptime_s,
          services: healthRes.value.services,
        });
      }
      if (queueRes.status === 'fulfilled') {
        merged.queues = queueRes.value.queues;
      }
      if (healthRes.status === 'rejected' && queueRes.status === 'rejected') {
        setHealthError('Could not reach Core API. Is it running?');
      }
      setHealth(merged);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : 'Failed to load health');
    } finally {
      setHealthLoading(false);
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

  const loadTriggers = useCallback(async () => {
    setTriggersError(null);
    try {
      const res = await triggersApi.list();
      setTriggers(res.data);
    } catch (err) {
      setTriggersError(err instanceof Error ? err.message : 'Failed to load triggers');
    } finally {
      setTriggersLoading(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.allSettled([loadHealth(), loadSkills(), loadTriggers()]);
  }, [loadHealth, loadSkills, loadTriggers]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }

  async function handleTriggerSkill(name: string) {
    await skillsApi.trigger(name);
  }

  async function handleAddTrigger(name: string, queryText: string) {
    await triggersApi.create(name, queryText);
    await loadTriggers();
  }

  async function handleDeleteTrigger(id: string) {
    await triggersApi.delete(id);
    await loadTriggers();
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <SystemHealthSection health={health} loading={healthLoading} error={healthError} />

      <Separator />

      <SkillsSection
        skills={skills}
        loading={skillsLoading}
        error={skillsError}
        onTrigger={handleTriggerSkill}
      />

      <Separator />

      <TriggersSection
        triggers={triggers}
        loading={triggersLoading}
        error={triggersError}
        onAdd={handleAddTrigger}
        onDelete={handleDeleteTrigger}
      />

      <Separator />

      <DangerZoneSection />
    </div>
  );
}
