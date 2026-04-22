'use client';

import { useState } from 'react';
import { Play, Loader2, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Pill } from '@/components/design-system';
import type { IntelligenceEntry } from '@/lib/api-client';
import { intelligenceApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp as a human-readable relative string.
 * Returns "Just now", "Xm ago", "Xh ago", or "MMM D".
 */
function formatRelative(isoString: string | Date): string {
  const date = typeof isoString === 'string' ? new Date(isoString) : isoString;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 2) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Map skill_name to a display-friendly label.
 */
function skillLabel(skillName: string): string {
  const labels: Record<string, string> = {
    'daily-connections': 'Daily Connections',
    'drift-monitor': 'Drift Monitor',
  };
  return labels[skillName] ?? skillName;
}

// ---------------------------------------------------------------------------
// SkillCard
// ---------------------------------------------------------------------------

interface SkillCardProps {
  /**
   * Which intelligence skill this card represents.
   * Must match the allowlist in intelligenceApi.trigger().
   */
  skill: 'daily-connections' | 'drift-monitor';
  /** Latest run data from intelligenceApi.summary(). Null = never run. */
  lastRun: IntelligenceEntry | null;
  /** Short description rendered below the card title. */
  description: string;
}

/**
 * Read-only card showing the last result for one intelligence skill
 * (daily-connections or drift-monitor) with a "Run now" trigger button.
 *
 * Client component — owns the trigger mutation state.
 * Rendered by IntelligencePage (RSC) which provides the pre-fetched lastRun.
 */
export function SkillCard({ skill, lastRun, description }: SkillCardProps) {
  const [triggering, setTriggering] = useState(false);
  const [justQueued, setJustQueued] = useState(false);

  async function handleTrigger() {
    setTriggering(true);
    try {
      await intelligenceApi.trigger(skill);
      setJustQueued(true);
      toast.success(`${skillLabel(skill)} queued — results available shortly.`);
      // Reset the "just queued" badge after 30s so it doesn't persist stale
      setTimeout(() => setJustQueued(false), 30_000);
    } catch {
      toast.error(`Failed to trigger ${skillLabel(skill)}. Please try again.`);
    } finally {
      setTriggering(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Status badge
  // ---------------------------------------------------------------------------

  function StatusBadge() {
    if (justQueued) {
      return (
        <Pill tone="warning" size="sm">
          <Loader2 size={10} className="animate-spin" />
          Queued
        </Pill>
      );
    }
    if (!lastRun) {
      return (
        <Pill tone="neutral" size="sm">
          <AlertCircle size={10} />
          Never run
        </Pill>
      );
    }
    return (
      <Pill tone="success" size="sm">
        <CheckCircle2 size={10} />
        {formatRelative(lastRun.created_at)}
      </Pill>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section className="bg-bg-container border border-cloud-light">
      {/* Card header */}
      <div className="flex items-start gap-4 px-[18px] py-[12px] border-b border-cloud-light">
        <div className="flex-1 min-w-0">
          <div className="font-display text-[15px] font-normal tracking-[-0.005em] text-text-heading">
            {skillLabel(skill)}
          </div>
          <div className="text-[12.5px] text-text-body-secondary mt-[3px] font-light tracking-[0.005em]">
            {description}
          </div>
        </div>

        {/* Actions: status badge + Run now button */}
        <div className="flex items-center gap-[8px] shrink-0">
          <StatusBadge />
          <Button
            variant="secondary"
            size="sm"
            icon={
              triggering
                ? <Loader2 size={11} strokeWidth={1.5} className="animate-spin" />
                : <Play size={11} strokeWidth={1.5} />
            }
            disabled={triggering}
            onClick={handleTrigger}
          >
            {triggering ? 'Queuing…' : 'Run now'}
          </Button>
        </div>
      </div>

      {/* Card body: last run summary */}
      <div className="px-[18px] py-[16px]">
        {lastRun ? (
          <div className="space-y-[10px]">
            {/* Output summary */}
            {lastRun.output_summary && (
              <div>
                <div className="font-mono text-[10px] tracking-[0.04em] uppercase text-text-body-secondary mb-[4px]">
                  Last output
                </div>
                <p className="text-[13px] text-text-body leading-[1.55] font-light m-0">
                  {lastRun.output_summary}
                </p>
              </div>
            )}

            {/* Metadata row */}
            <div className="flex items-center gap-[14px] pt-[4px]">
              <span className="flex items-center gap-[4px] font-mono text-[10.5px] text-text-body-secondary">
                <Clock size={10} strokeWidth={1.5} />
                {new Date(lastRun.created_at).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              {lastRun.duration_ms !== null && (
                <span className="font-mono text-[10.5px] text-text-body-secondary">
                  {(lastRun.duration_ms / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-text-body-secondary font-light m-0 italic">
            No runs recorded yet. Click &ldquo;Run now&rdquo; to generate an initial result.
          </p>
        )}
      </div>
    </section>
  );
}
