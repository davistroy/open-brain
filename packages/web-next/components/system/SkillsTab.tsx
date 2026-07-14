'use client';

/**
 * SkillsTab — System page tab 3.
 *
 * Displays configured skills with last-run metadata. Each skill row has:
 *   - Name + schedule (cron string or "manual only")
 *   - Description (truncated)
 *   - Last run time (relative) + last duration
 *   - Trigger button → POST /api/v1/skills/:name/trigger (fire-and-forget, toast)
 *   - Edit schedule → inline cron input → PATCH /api/v1/skills/:name
 *
 * Data is passed from the RSC page (server-prefetched skills list).
 * Mutations use TanStack Query useMutation + fire-and-forget pattern with sonner toasts.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Play, Edit2, Check, X, Clock } from 'lucide-react';
import { Button } from '@/components/design-system';
import { useClientNow } from '@/hooks/useClientNow';
import { useTriggerSkill, useUpdateSkillSchedule } from '@/lib/api/skills.hooks';
import type { SkillRecord } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtRelative(iso: string | null, now: number | null): string {
  if (!iso) return 'Never';
  // Pre-mount (SSR + first client render): stable absolute date, no `now` dependency.
  if (now === null) return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const diff = now - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'Just now';
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// SkillRow
// ---------------------------------------------------------------------------

interface SkillRowProps {
  skill: SkillRecord;
}

function SkillRow({ skill }: SkillRowProps) {
  const now = useClientNow();
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleInput, setScheduleInput] = useState(skill.schedule ?? '');

  // Trigger mutation — fire-and-forget (202 queued)
  const triggerMutation = useTriggerSkill();

  // Schedule update mutation
  const scheduleMutation = useUpdateSkillSchedule();

  function handleCancelEdit() {
    setScheduleInput(skill.schedule ?? '');
    setEditingSchedule(false);
  }

  return (
    <div className="py-[12px] border-b border-cloud-light last:border-0">
      <div className="flex items-start gap-[12px]">
        {/* Left: name + schedule + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[8px] mb-[2px]">
            <span className="text-[13px] font-mono font-normal text-text-heading">
              {skill.name}
            </span>
            {/* Schedule badge */}
            {!editingSchedule && (
              <span className="inline-flex items-center gap-[4px] text-[10.5px] text-text-body-secondary font-mono bg-cloud-light px-[6px] py-[1px]">
                <Clock size={9} strokeWidth={1.5} />
                {skill.schedule ?? 'manual only'}
              </span>
            )}
          </div>

          {/* Description */}
          {skill.description && (
            <div className="text-[12px] text-text-body-secondary font-light mb-[4px] truncate">
              {skill.description}
            </div>
          )}

          {/* Inline schedule editor */}
          {editingSchedule && (
            <div className="flex items-center gap-[6px] mt-[6px]">
              <input
                type="text"
                value={scheduleInput}
                onChange={(e) => setScheduleInput(e.target.value)}
                placeholder="cron expression (e.g. 0 4 * * 0)"
                className={[
                  'flex-1 text-[12px] font-mono border border-cloud-medium bg-bg-container',
                  'px-[8px] py-[4px] text-text-heading outline-none',
                  'focus:border-book-cloth',
                  'placeholder:text-text-body-secondary',
                ].join(' ')}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') scheduleMutation.mutate(
                    { name: skill.name, schedule: scheduleInput.trim() },
                    {
                      onSuccess: (result) => {
                        toast.success(`Schedule updated: ${result.schedule}`);
                        setEditingSchedule(false);
                        skill.schedule = result.schedule;
                      },
                      onError: (err: unknown) => {
                        const message = err instanceof Error ? err.message : 'Update failed';
                        toast.error(`Failed to update schedule: ${message}`);
                      },
                    },
                  );
                  if (e.key === 'Escape') handleCancelEdit();
                }}
              />
              <Button
                variant="primary"
                size="sm"
                icon={<Check size={11} strokeWidth={1.5} />}
                onClick={() => scheduleMutation.mutate(
                    { name: skill.name, schedule: scheduleInput.trim() },
                    {
                      onSuccess: (result) => {
                        toast.success(`Schedule updated: ${result.schedule}`);
                        setEditingSchedule(false);
                        skill.schedule = result.schedule;
                      },
                      onError: (err: unknown) => {
                        const message = err instanceof Error ? err.message : 'Update failed';
                        toast.error(`Failed to update schedule: ${message}`);
                      },
                    },
                  )}
                disabled={scheduleMutation.isPending || !scheduleInput.trim()}
              >
                {scheduleMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<X size={11} strokeWidth={1.5} />}
                onClick={handleCancelEdit}
                disabled={scheduleMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          )}

          {/* Last run meta */}
          {!editingSchedule && (
            <div className="flex items-center gap-[12px] mt-[4px] text-[11px] text-text-body-secondary font-light">
              <span>Last run: {fmtRelative(skill.last_run_at, now)}</span>
              {skill.last_duration_ms !== null && (
                <span>{fmtDuration(skill.last_duration_ms)}</span>
              )}
              {skill.last_output_summary && (
                <span className="truncate max-w-[300px]" title={skill.last_output_summary}>
                  {skill.last_output_summary.slice(0, 80)}
                  {skill.last_output_summary.length > 80 ? '…' : ''}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right: action buttons */}
        {!editingSchedule && (
          <div className="flex items-center gap-[6px] shrink-0">
            <Button
              variant="ghost"
              size="sm"
              icon={<Edit2 size={11} strokeWidth={1.5} />}
              onClick={() => setEditingSchedule(true)}
              title="Edit schedule"
            />
            <Button
              variant="secondary"
              size="sm"
              icon={<Play size={11} strokeWidth={1.5} />}
              onClick={() =>
                triggerMutation.mutate(
                  { name: skill.name },
                  {
                    onSuccess: (result) => {
                      toast.success(`Skill "${skill.name}" queued (job ${result.job_id})`);
                    },
                    onError: (err: unknown) => {
                      const message = err instanceof Error ? err.message : 'Trigger failed';
                      toast.error(`Failed to trigger "${skill.name}": ${message}`);
                    },
                  },
                )
              }
              disabled={triggerMutation.isPending}
              title={`Trigger ${skill.name} now`}
            >
              {triggerMutation.isPending ? 'Queuing…' : 'Run'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface SkillsTabProps {
  skills: SkillRecord[];
}

export function SkillsTab({ skills }: SkillsTabProps) {
  const [filter, setFilter] = useState('');

  const filtered = filter
    ? skills.filter(
        (s) =>
          s.name.includes(filter.toLowerCase()) ||
          (s.description ?? '').toLowerCase().includes(filter.toLowerCase()),
      )
    : skills;

  return (
    <div>
      {/* Filter bar */}
      <div className="flex items-center justify-between mb-[16px]">
        <div className="text-[12.5px] text-text-body-secondary font-light">
          {skills.length} skill{skills.length !== 1 ? 's' : ''} configured
        </div>
        <input
          type="text"
          placeholder="Filter skills…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={[
            'text-[12px] border border-cloud-medium bg-bg-container',
            'px-[10px] py-[5px] w-[220px] text-text-heading outline-none',
            'focus:border-book-cloth placeholder:text-text-body-secondary',
          ].join(' ')}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="py-[48px] text-center text-[13px] text-text-body-secondary font-light">
          {filter ? 'No skills match your filter.' : 'No skills configured.'}
        </div>
      ) : (
        <div className="bg-bg-container border border-cloud-light px-[14px]">
          {filtered.map((skill) => (
            <SkillRow key={skill.name} skill={skill} />
          ))}
        </div>
      )}

      <div className="mt-[12px] text-[11px] text-text-body-secondary font-light">
        Trigger runs the skill immediately at maximum priority. Schedule changes persist
        to <span className="font-mono">config/skills.yaml</span>.
      </div>
    </div>
  );
}
