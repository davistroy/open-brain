import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  XCircle,
  Loader2,
  Pencil,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Skill, SkillLastRun } from '@/lib/types';
import { relativeTime, formatDuration, describeCron, isValidCron } from './helpers';

export interface SkillsTabProps {
  skills: Skill[];
  skillRuns: SkillLastRun[];
  loading: boolean;
  error: string | null;
  onTrigger: (name: string) => Promise<void>;
  onScheduleUpdate: (name: string, schedule: string) => Promise<void>;
}

export function SkillsTab({
  skills,
  skillRuns,
  loading,
  error,
  onTrigger,
  onScheduleUpdate,
}: SkillsTabProps) {
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});

  // Schedule editing state
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

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

  function handleEditClick(skillName: string, currentSchedule: string) {
    setEditingSkill(skillName);
    setEditValue(currentSchedule);
    setEditError(null);
    setSaveSuccess(null);
  }

  function handleCancel() {
    setEditingSkill(null);
    setEditValue('');
    setEditError(null);
  }

  async function handleSave(skillName: string) {
    const trimmed = editValue.trim();
    if (!isValidCron(trimmed)) {
      setEditError('Invalid cron expression. Expected 5 fields: minute hour day month weekday');
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      await onScheduleUpdate(skillName, trimmed);
      setEditingSkill(null);
      setEditValue('');
      setSaveSuccess(skillName);
      setTimeout(() => setSaveSuccess((prev) => prev === skillName ? null : prev), 3000);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update schedule');
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent, skillName: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave(skillName);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
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
        const isEditing = editingSkill === skill.name;
        const justSaved = saveSuccess === skill.name;

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
                {justSaved && (
                  <span className="text-xs text-green-600 dark:text-green-400">Schedule updated</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {isEditing ? (
                  <div className="mt-1 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground shrink-0">Schedule:</span>
                      <Input
                        value={editValue}
                        onChange={(e) => { setEditValue(e.target.value); setEditError(null); }}
                        onKeyDown={(e) => handleKeyDown(e, skill.name)}
                        className="w-48 h-6 px-2 font-mono text-xs"
                        placeholder="0 20 * * 0"
                        autoFocus
                        disabled={saving}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
                        onClick={() => handleSave(skill.name)}
                        disabled={saving}
                        aria-label="Save schedule"
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        onClick={handleCancel}
                        disabled={saving}
                        aria-label="Cancel editing"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {editValue.trim() && describeCron(editValue.trim()) !== editValue.trim() && (
                      <p className="text-xs text-muted-foreground ml-[4.5rem]">{describeCron(editValue.trim())}</p>
                    )}
                    {editError && (
                      <p className="text-xs text-destructive ml-[4.5rem]">{editError}</p>
                    )}
                  </div>
                ) : (
                  <span
                    className="inline-flex items-center gap-1 group cursor-pointer hover:text-foreground transition-colors"
                    onClick={() => handleEditClick(skill.name, skill.schedule ?? '')}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleEditClick(skill.name, skill.schedule ?? ''); }}
                    title="Click to edit schedule"
                  >
                    {skill.schedule ? describeCron(skill.schedule) : 'No schedule'}
                    <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
                  </span>
                )}
                {!isEditing && lastRunAt && (
                  <span>Last: {relativeTime(lastRunAt)}</span>
                )}
                {!isEditing && duration != null && (
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
