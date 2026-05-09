'use client';

/**
 * TriggersSection — Settings page semantic trigger management.
 *
 * Renders the full list of semantic triggers and an inline "add trigger" form.
 * Each trigger fires a Pushover/Slack notification when a new capture matches
 * its semantic query above a configurable threshold.
 *
 * API surface (matches packages/core-api/src/routes/triggers.ts):
 *   GET    /api/v1/triggers          → { triggers: Trigger[] }
 *   POST   /api/v1/triggers          → { trigger: Trigger }   (201)
 *   DELETE /api/v1/triggers/:id      → { message: string }
 *
 * Patterns established by this EXEMPLAR section:
 * - List data via TanStack Query useQuery; mutations via useMutation + invalidateQueries.
 * - Inline "add" form toggled with local useState; form fields cleared on success.
 * - Error UI: inline alert div with status-error CSS vars (no Flashbar; no toast).
 * - Loading UI: skeleton pulse rows (same shape as real rows) shown during initial load.
 * - List UI: Card wrapper with `padded={false}` + `actions` slot for the Add button;
 *   rows in `divide-y` container inside `px-[18px]`.
 * - Optimistic delete: mutation, then `queryClient.invalidateQueries` (not setQueryData —
 *   the list shape is more complex; full re-fetch is safe and simpler).
 * - Client component required (list + form interactivity).
 *
 * UX parity with packages/web/src/components/settings/TriggersSection.tsx:
 * - Same fields (name + query_text) for create.
 * - Same display fields: name, active badge, delivery channel badge, query_text, threshold,
 *   cooldown_minutes, fire_count, last_fired_at.
 * - Same UX: delete button per row (no confirmation dialog; immediate).
 * - Add button toggled in the Card header actions slot (web uses a standalone button).
 */

import { useState } from 'react';
import { Plus, Trash2, TriangleAlert, RefreshCw } from 'lucide-react';
import { Card } from '@/components/design-system/Card';
import { Button } from '@/components/design-system/Button';
import { Input } from '@/components/design-system/Input';
import { useTriggers, useCreateTrigger, useDeleteTrigger } from '@/lib/api/config.hooks';
import type { Trigger } from '@/lib/types';

// ---------------------------------------------------------------------------
// Inline error alert — matches DangerZoneSection error pattern
// ---------------------------------------------------------------------------

function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-3 px-4 py-3 border border-[var(--color-status-error-border)] bg-[var(--color-status-error-bg)]"
      role="alert"
    >
      <TriangleAlert
        size={14}
        strokeWidth={1.5}
        className="text-[var(--color-status-error-fg)] shrink-0 mt-[1px]"
      />
      <p className="text-[12.5px] text-[var(--color-status-error-fg)] font-light leading-[1.5]">
        {message}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton row — used during initial list load
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[14px] flex items-center justify-between gap-4">
      <div className="flex flex-col gap-[6px] flex-1 min-w-0">
        <div className="h-[13px] w-[140px] bg-cloud-light animate-pulse" />
        <div className="h-[11px] w-[240px] bg-cloud-light animate-pulse opacity-60" />
      </div>
      <div className="h-[22px] w-[22px] bg-cloud-light animate-pulse shrink-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active/delivery badges — inline spans (no separate component needed)
// ---------------------------------------------------------------------------

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center px-[6px] py-[1px] text-[10.5px] font-medium tracking-[0.02em]',
        active
          ? 'bg-[var(--color-status-success-bg)] border border-[var(--color-status-success-border)] text-[var(--color-status-success-fg)]'
          : 'bg-cloud-light border border-cloud-dark text-text-small',
      ].join(' ')}
    >
      {active ? 'active' : 'inactive'}
    </span>
  );
}

function DeliveryBadge({ channel }: { channel: string }) {
  return (
    <span className="inline-flex items-center px-[6px] py-[1px] text-[10.5px] font-medium tracking-[0.02em] bg-bg-container border border-cloud-dark text-text-small capitalize">
      {channel}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TriggerRow — single row in the list
// ---------------------------------------------------------------------------

interface TriggerRowProps {
  trigger: Trigger;
  onDelete: (id: string) => void;
  deleting: boolean;
}

function TriggerRow({ trigger, onDelete, deleting }: TriggerRowProps) {
  const isActive = trigger.is_active ?? trigger.enabled;

  return (
    <div className="px-[18px] py-[13px] flex items-start justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <div className="flex-1 min-w-0">
        {/* Name + badges */}
        <div className="flex items-center flex-wrap gap-[6px] mb-[3px]">
          <span className="text-[13px] font-medium text-text-heading">{trigger.name}</span>
          <ActiveBadge active={isActive} />
          {trigger.delivery_channel && (
            <DeliveryBadge channel={trigger.delivery_channel} />
          )}
        </div>

        {/* Query text */}
        {trigger.query_text && (
          <p className="text-[11.5px] text-text-body-secondary font-mono truncate leading-[16px] mt-[1px]">
            {trigger.query_text}
          </p>
        )}

        {/* Metadata row */}
        <div className="flex flex-wrap gap-x-3 mt-[3px]">
          {trigger.threshold !== undefined && (
            <span className="text-[11px] text-text-small font-light">
              Threshold: {trigger.threshold}
            </span>
          )}
          {trigger.cooldown_minutes !== undefined && (
            <span className="text-[11px] text-text-small font-light">
              Cooldown: {trigger.cooldown_minutes}m
            </span>
          )}
          {trigger.fire_count !== undefined && (
            <span className="text-[11px] text-text-small font-light">
              Fired: {trigger.fire_count}&times;
            </span>
          )}
          {trigger.last_fired_at && (
            <span className="text-[11px] text-text-small font-light">
              Last: {new Date(trigger.last_fired_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Delete button */}
      <button
        type="button"
        onClick={() => onDelete(trigger.id)}
        disabled={deleting}
        aria-label={`Delete trigger ${trigger.name}`}
        className={[
          'shrink-0 p-[4px] text-text-small rounded-none',
          'hover:text-[var(--color-status-error-fg)] hover:bg-[var(--color-status-error-bg)]',
          'transition-colors duration-[120ms]',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        ].join(' ')}
      >
        <Trash2 size={13} strokeWidth={1.5} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddTriggerForm — inline form shown when "Add" is toggled
// ---------------------------------------------------------------------------

interface AddTriggerFormProps {
  onAdd: (name: string, queryText: string) => Promise<void>;
  onCancel: () => void;
}

function AddTriggerForm({ onAdd, onCancel }: AddTriggerFormProps) {
  const [name, setName] = useState('');
  const [queryText, setQueryText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !queryText.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(name.trim(), queryText.trim());
      // Success: parent will hide the form by toggling `adding` state
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add trigger');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = name.trim().length > 0 && queryText.trim().length > 0;

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="px-[18px] py-[14px] border-b border-cloud-light bg-[var(--color-ivory-medium)]"
    >
      <p className="text-[12px] font-medium text-text-heading mb-[10px]">New trigger</p>

      <div className="flex flex-col gap-[8px]">
        <Input
          label="Name"
          placeholder="e.g. client-risk-mentions"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          required
        />
        <Input
          label="Semantic query"
          placeholder="e.g. client escalation risk blowup"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          disabled={submitting}
          required
        />
      </div>

      {error && (
        <p className="mt-[8px] text-[12px] text-[var(--color-status-error-fg)]">{error}</p>
      )}

      <div className="flex items-center gap-[8px] mt-[12px]">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSubmit || submitting}
          icon={
            submitting ? (
              <RefreshCw size={11} strokeWidth={1.5} className="animate-spin" />
            ) : undefined
          }
        >
          {submitting ? 'Adding…' : 'Add trigger'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// TriggersSection — main exported component
// ---------------------------------------------------------------------------

export function TriggersSection() {
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Fetch list ────────────────────────────────────────────────────────────
  const { data, isLoading, isError, error } = useTriggers();

  const triggers = data?.triggers ?? [];

  // ── Mutations ─────────────────────────────────────────────────────────────
  const createMutation = useCreateTrigger();
  const deleteMutation = useDeleteTrigger();

  function handleAdd(name: string, queryText: string): Promise<void> {
    return createMutation.mutateAsync({ name, queryText }).then(() => {
      setAdding(false);
    });
  }

  function handleDelete(id: string) {
    setDeletingId(id);
    deleteMutation.mutate(id, {
      onSuccess: () => setDeletingId(null),
      onError: () => setDeletingId(null),
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Card
      header="Semantic triggers"
      description="Triggers fire a Pushover or Slack notification when a new capture matches a semantic query above the configured threshold."
      padded={false}
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={11} strokeWidth={1.5} />}
          onClick={() => setAdding((v) => !v)}
          aria-pressed={adding}
        >
          {adding ? 'Cancel' : 'Add'}
        </Button>
      }
    >
      {/* ── Load error ──────────────────────────────────────────────────── */}
      {isError && (
        <div className="px-[18px] py-[14px]">
          <ErrorAlert
            message={
              error instanceof Error
                ? error.message
                : 'Failed to load triggers. Try refreshing.'
            }
          />
        </div>
      )}

      {/* ── Add form ────────────────────────────────────────────────────── */}
      {adding && !isError && (
        <AddTriggerForm
          onAdd={handleAdd}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* ── List: loading skeleton ───────────────────────────────────────── */}
      {isLoading && !isError && (
        <>
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── List: empty state ────────────────────────────────────────────── */}
      {!isLoading && !isError && triggers.length === 0 && (
        <div className="px-[18px] py-[32px] text-center border-t border-cloud-light">
          <p className="text-[13px] text-text-body-secondary font-light">
            No triggers configured.
          </p>
          <p className="text-[12px] text-text-small font-light mt-[4px]">
            Add a trigger to receive a notification when a capture matches a query.
          </p>
        </div>
      )}

      {/* ── List: trigger rows ────────────────────────────────────────────── */}
      {!isLoading && !isError && triggers.length > 0 && (
        <div className="divide-y divide-cloud-light">
          {triggers.map((trigger) => (
            <TriggerRow
              key={trigger.id}
              trigger={trigger}
              onDelete={handleDelete}
              deleting={deletingId === trigger.id}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
