'use client';

// ---------------------------------------------------------------------------
// CaptureHabitStep — Step 3 of the onboarding wizard
//
// Presents 4 capture habit cards. User selects one. Selection is persisted
// via settingsApi.put('capture_habit', id) before advancing to step 4.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { settingsApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Habit definitions
// ---------------------------------------------------------------------------

interface HabitOption {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  example: string;
}

function MorningIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79zM4 10.5H1v2h3zM13 .55h-2V3.5h2zM20.45 4.46l-1.41-1.41-1.79 1.79 1.41 1.41zM17.24 18.16l1.79 1.8 1.41-1.41-1.8-1.79zM20 10.5v2h3v-2zM12 5.5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2zm-7.45-2.34l1.41 1.41 1.79-1.8-1.41-1.41z" />
    </svg>
  );
}

function MeetingIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z" />
    </svg>
  );
}

function EveningIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" />
    </svg>
  );
}

function AdHocIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}

const HABITS: HabitOption[] = [
  {
    id: 'morning_brain_dump',
    title: 'Morning brain dump',
    description: 'Clear your head at the start of each day — decisions, ideas, and intentions.',
    icon: <MorningIcon />,
    example: '"Before coffee: what\'s on my mind today"',
  },
  {
    id: 'meeting_notes',
    title: 'Meeting notes',
    description: 'Capture key decisions, action items, and insights right after meetings.',
    icon: <MeetingIcon />,
    example: '"Post-standup: what was decided"',
  },
  {
    id: 'end_of_day_reflection',
    title: 'End-of-day reflection',
    description: 'Close the loop on what you shipped, blocked on, or learned.',
    icon: <EveningIcon />,
    example: '"EOD: wins, blockers, follow-ups"',
  },
  {
    id: 'ad_hoc',
    title: 'Ad hoc',
    description: 'Capture whenever inspiration strikes — no schedule, just capture.',
    icon: <AdHocIcon />,
    example: '"Whenever something worth capturing happens"',
  },
];

// ---------------------------------------------------------------------------
// HabitCard
// ---------------------------------------------------------------------------

interface HabitCardProps {
  habit: HabitOption;
  isSelected: boolean;
  onSelect: () => void;
}

function HabitCard({ habit, isSelected, onSelect }: HabitCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left transition-colors duration-150"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '14px',
        padding: '16px',
        borderRadius: 'var(--border-radius-card)',
        border: isSelected
          ? '2px solid var(--color-book-cloth)'
          : '1px solid var(--color-border-card)',
        background: isSelected
          ? 'var(--color-book-cloth-wash)'
          : 'var(--color-bg-surface)',
        cursor: 'pointer',
        outline: 'none',
      }}
      aria-pressed={isSelected}
    >
      {/* Icon */}
      <div
        style={{
          flexShrink: 0,
          width: 40,
          height: 40,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isSelected ? 'var(--color-book-cloth)' : 'var(--color-ivory-medium)',
          color: isSelected ? 'white' : 'var(--color-text-body-secondary)',
          transition: 'background 150ms, color 150ms',
        }}
      >
        {habit.icon}
      </div>

      {/* Text */}
      <div className="flex flex-col gap-1 min-w-0">
        <span
          className="text-[14px] font-semibold leading-snug"
          style={{ color: 'var(--color-text-heading)' }}
        >
          {habit.title}
        </span>
        <span
          className="text-[12px] leading-relaxed"
          style={{ color: 'var(--color-text-body-secondary)' }}
        >
          {habit.description}
        </span>
        <span
          className="text-[11px] italic mt-0.5"
          style={{ color: 'var(--color-text-small)' }}
        >
          {habit.example}
        </span>
      </div>

      {/* Selection indicator */}
      {isSelected && (
        <div
          style={{
            flexShrink: 0,
            marginLeft: 'auto',
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--color-book-cloth)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CaptureHabitStep — exported component
// ---------------------------------------------------------------------------

export interface CaptureHabitStepProps {
  /** Called when user advances to step 4 */
  onNext: () => void;
  /** Called when user goes back to step 2 */
  onBack: () => void;
  /** Pre-selected habit ID (from localStorage state) */
  initialSelection?: string;
  /** Saving state passed in from wizard (shared with finish flow) */
  isSaving?: boolean;
}

export function CaptureHabitStep({
  onNext,
  onBack,
  initialSelection,
  isSaving = false,
}: CaptureHabitStepProps) {
  const [selected, setSelected] = useState<string>(initialSelection ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWorking = saving || isSaving;

  const handleContinue = async () => {
    if (!selected || isWorking) return;

    setError(null);
    setSaving(true);
    try {
      await settingsApi.put('capture_habit', selected);
      onNext();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to save capture habit. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h2
          className="mb-1"
          style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 'var(--font-size-heading-l)',
            fontWeight: 700,
            letterSpacing: 'var(--letter-spacing-heading-l)',
            color: 'var(--color-text-heading)',
          }}
        >
          Choose a capture habit
        </h2>
        <p style={{ color: 'var(--color-text-body-secondary)', margin: 0, fontSize: '14px' }}>
          Select the cadence that fits how you think — we&apos;ll remind you at the right moments.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="px-4 py-3 text-[13px] rounded-sm"
          style={{
            backgroundColor: 'var(--color-status-error-bg)',
            border: '1px solid var(--color-status-error-border)',
            color: 'var(--color-status-error-fg)',
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Habit cards */}
      <div className="flex flex-col gap-3">
        {HABITS.map((habit) => (
          <HabitCard
            key={habit.id}
            habit={habit}
            isSelected={selected === habit.id}
            onSelect={() => setSelected(habit.id)}
          />
        ))}
      </div>

      {/* Navigation */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          disabled={isWorking}
          className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-cloud-medium)',
            color: 'var(--color-text-body)',
            borderRadius: 'var(--border-radius-button)',
            cursor: isWorking ? undefined : 'pointer',
          }}
          onMouseEnter={(e) => {
            if (!isWorking) e.currentTarget.style.background = 'var(--color-ivory-medium)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
          </svg>
          Back
        </button>

        <button
          type="button"
          onClick={handleContinue}
          disabled={!selected || isWorking}
          className="flex items-center gap-2 px-6 py-2.5 text-[14px] font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            backgroundColor: 'var(--color-button-primary-bg)',
            color: 'var(--color-button-primary-text)',
            borderRadius: 'var(--border-radius-button)',
            border: 'none',
            cursor: selected && !isWorking ? 'pointer' : undefined,
          }}
          onMouseEnter={(e) => {
            if (selected && !isWorking) {
              e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg-hover)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg)';
          }}
        >
          {saving ? (
            <>
              <svg
                className="animate-spin"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="3" />
                <path
                  d="M12 2a10 10 0 0 1 10 10"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              Saving…
            </>
          ) : (
            <>
              Continue
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="white"
                aria-hidden="true"
              >
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
