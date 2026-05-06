'use client';

/**
 * EmailAllowlistSection — Settings page email sender allowlist management.
 *
 * Controls which senders can create captures via brain@troy-davis.com.
 * Entries are either exact email addresses (user@example.com) or domain
 * wildcards (@example.com). Removing a sender silently disables all future
 * emails from that address — so delete requires a click-again confirmation.
 *
 * API surface (app_settings key 'email_allowlist'):
 *   GET /api/v1/settings/email_allowlist → { key, value: string[], updated_at }
 *   PUT /api/v1/settings/email_allowlist → { key, value: string[], updated_at }
 *   (404 on GET = allowlist not yet set = empty; treated as [])
 *
 * The allowlist is a plain string[] — no row IDs. Add/remove is a full-array
 * replace (read current list, splice, PUT). The emailAllowlistApi namespace in
 * api-client.ts wraps this into list/add/remove methods for clean consumption.
 *
 * Patterns follow the TriggersSection exemplar:
 * - useQuery + useMutation + invalidateQueries (TanStack Query v5)
 * - Inline "add" form toggled with local useState
 * - ErrorAlert for load errors; inline form errors for add/remove
 * - Skeleton pulse rows during initial load
 * - Card wrapper (padded={false}) + actions slot for the Add button
 *
 * UX delta from TriggersSection: delete requires click-again confirmation
 * (inline two-step, not immediate). Removing a sender is a silent security
 * change — immediate delete with no confirmation is too dangerous.
 * No Modal/Dialog exists in the design-system; using inline confirm pattern.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, TriangleAlert, RefreshCw, Mail } from 'lucide-react';
import { Card } from '@/components/design-system/Card';
import { Button } from '@/components/design-system/Button';
import { Input } from '@/components/design-system/Input';
import { emailAllowlistApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Query key
// ---------------------------------------------------------------------------

const ALLOWLIST_QUERY_KEY = ['settings', 'email_allowlist'] as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateEntry(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return 'Entry cannot be empty';
  if (trimmed.startsWith('@')) {
    // Domain pattern: @example.com
    if (!/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) {
      return 'Invalid domain format. Use @example.com';
    }
    return null;
  }
  // Email address
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return 'Invalid email address';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline error alert — matches TriggersSection / DangerZoneSection pattern
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
// Skeleton row — shown during initial load
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-[18px] py-[13px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      <div className="flex items-center gap-[8px] flex-1 min-w-0">
        <div className="h-[13px] w-[13px] bg-cloud-light animate-pulse shrink-0" />
        <div className="h-[13px] w-[200px] bg-cloud-light animate-pulse" />
        <div className="h-[16px] w-[44px] bg-cloud-light animate-pulse" />
      </div>
      <div className="h-[22px] w-[22px] bg-cloud-light animate-pulse shrink-0" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry badge — "domain" vs "exact" indicator
// ---------------------------------------------------------------------------

function EntryTypeBadge({ entry }: { entry: string }) {
  const isDomain = entry.startsWith('@');
  return (
    <span
      className={[
        'inline-flex items-center px-[6px] py-[1px] text-[10.5px] font-medium tracking-[0.02em]',
        isDomain
          ? 'bg-[var(--color-status-success-bg)] border border-[var(--color-status-success-border)] text-[var(--color-status-success-fg)]'
          : 'bg-bg-container border border-cloud-dark text-text-small',
      ].join(' ')}
    >
      {isDomain ? 'domain' : 'exact'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AllowlistRow — single entry row with inline confirm-to-delete
// ---------------------------------------------------------------------------

interface AllowlistRowProps {
  entry: string;
  onRemove: (entry: string) => void;
  removing: boolean;
}

function AllowlistRow({ entry, onRemove, removing }: AllowlistRowProps) {
  const [confirmPending, setConfirmPending] = useState(false);

  function handleDeleteClick() {
    if (confirmPending) {
      // Second click — execute delete
      setConfirmPending(false);
      onRemove(entry);
    } else {
      // First click — arm confirmation
      setConfirmPending(true);
    }
  }

  function handleBlur() {
    // Cancel confirmation if focus leaves (keyboard nav / tab away)
    setConfirmPending(false);
  }

  return (
    <div className="px-[18px] py-[13px] flex items-center justify-between gap-4 border-b border-cloud-light last:border-b-0">
      {/* Entry + type badge */}
      <div className="flex items-center gap-[8px] flex-1 min-w-0">
        <Mail
          size={13}
          strokeWidth={1.5}
          className="text-text-body-secondary shrink-0"
        />
        <span className="text-[13px] font-mono text-text-body truncate">
          {entry}
        </span>
        <EntryTypeBadge entry={entry} />
      </div>

      {/* Delete button — two-step inline confirm */}
      <button
        type="button"
        onClick={handleDeleteClick}
        onBlur={handleBlur}
        disabled={removing}
        aria-label={
          confirmPending
            ? `Confirm removing ${entry}`
            : `Remove ${entry}`
        }
        title={confirmPending ? 'Click again to confirm removal' : 'Remove sender'}
        className={[
          'shrink-0 flex items-center gap-[4px] px-[6px] py-[3px] rounded-none text-[11px] font-light',
          'transition-colors duration-[120ms]',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          confirmPending
            ? 'border border-[var(--color-status-error-border)] bg-[var(--color-status-error-bg)] text-[var(--color-status-error-fg)]'
            : 'border border-transparent text-text-small hover:text-[var(--color-status-error-fg)] hover:bg-[var(--color-status-error-bg)]',
        ].join(' ')}
      >
        {removing ? (
          <RefreshCw size={12} strokeWidth={1.5} className="animate-spin" />
        ) : (
          <Trash2 size={12} strokeWidth={1.5} />
        )}
        {confirmPending && (
          <span>Confirm</span>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddAllowlistForm — inline form toggled by the "Add" button
// ---------------------------------------------------------------------------

interface AddAllowlistFormProps {
  existingEntries: string[];
  onAdd: (entry: string) => Promise<void>;
  onCancel: () => void;
}

function AddAllowlistForm({ existingEntries, onAdd, onCancel }: AddAllowlistFormProps) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim().toLowerCase();

    const validationError = validateEntry(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (existingEntries.includes(trimmed)) {
      setError('Already in the allowlist');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onAdd(trimmed);
      // Success: parent toggles adding=false, form unmounts
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add entry');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = value.trim().length > 0;

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="px-[18px] py-[14px] border-b border-cloud-light bg-[var(--color-ivory-medium)]"
    >
      <p className="text-[12px] font-medium text-text-heading mb-[10px]">
        Add allowed sender
      </p>

      <Input
        label="Email address or domain"
        placeholder="user@example.com or @example.com"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        error={error ?? undefined}
        disabled={submitting}
        autoFocus
        required
      />

      <p className="mt-[6px] text-[11.5px] text-text-small font-light leading-[1.5]">
        Use a full address (<code className="font-mono">user@example.com</code>) for exact matching, or
        a domain starting with <code className="font-mono">@</code> (e.g. <code className="font-mono">@example.com</code>) to allow all senders from that domain.
      </p>

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
          {submitting ? 'Adding…' : 'Add sender'}
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
// EmailAllowlistSection — main exported component
// ---------------------------------------------------------------------------

export function EmailAllowlistSection() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [removingEntry, setRemovingEntry] = useState<string | null>(null);

  // ── Fetch list ─────────────────────────────────────────────────────────────
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ALLOWLIST_QUERY_KEY,
    queryFn: () => emailAllowlistApi.list(),
    staleTime: 30_000,
  });

  const entries: string[] = data ?? [];

  // ── Add mutation ───────────────────────────────────────────────────────────
  const addMutation = useMutation({
    mutationFn: (entry: string) => emailAllowlistApi.add(entries, entry),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ALLOWLIST_QUERY_KEY });
      setAdding(false);
    },
  });

  // ── Remove mutation ────────────────────────────────────────────────────────
  const removeMutation = useMutation({
    mutationFn: (entry: string) => emailAllowlistApi.remove(entries, entry),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ALLOWLIST_QUERY_KEY });
      setRemovingEntry(null);
    },
    onError: () => {
      setRemovingEntry(null);
    },
  });

  function handleAdd(entry: string): Promise<void> {
    return addMutation.mutateAsync(entry).then(() => undefined);
  }

  function handleRemove(entry: string) {
    setRemovingEntry(entry);
    removeMutation.mutate(entry);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Card
      header="Email allowlist"
      description="Controls which senders can create captures via brain@troy-davis.com. All other senders are silently rejected."
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
      {/* ── Load error ────────────────────────────────────────────────────── */}
      {isError && (
        <div className="px-[18px] py-[14px]">
          <ErrorAlert
            message={
              error instanceof Error
                ? error.message
                : 'Failed to load email allowlist. Try refreshing.'
            }
          />
        </div>
      )}

      {/* ── Add form ──────────────────────────────────────────────────────── */}
      {adding && !isError && (
        <AddAllowlistForm
          existingEntries={entries}
          onAdd={handleAdd}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* ── Remove error ──────────────────────────────────────────────────── */}
      {removeMutation.isError && (
        <div className="px-[18px] py-[10px]">
          <ErrorAlert
            message={
              removeMutation.error instanceof Error
                ? removeMutation.error.message
                : 'Failed to remove entry — please try again.'
            }
          />
        </div>
      )}

      {/* ── List: loading skeleton ────────────────────────────────────────── */}
      {isLoading && !isError && (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* ── List: empty state ─────────────────────────────────────────────── */}
      {!isLoading && !isError && entries.length === 0 && (
        <div className="px-[18px] py-[32px] text-center border-t border-cloud-light">
          <p className="text-[13px] text-text-body-secondary font-light">
            No senders configured.
          </p>
          <p className="text-[12px] text-text-small font-light mt-[4px]">
            All emails to brain@troy-davis.com will be rejected until you add at least one entry.
          </p>
        </div>
      )}

      {/* ── List: entry rows ──────────────────────────────────────────────── */}
      {!isLoading && !isError && entries.length > 0 && (
        <div>
          {entries.map((entry) => (
            <AllowlistRow
              key={entry}
              entry={entry}
              onRemove={handleRemove}
              removing={removingEntry === entry}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
