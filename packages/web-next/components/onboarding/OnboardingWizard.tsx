'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { StepIndicator, type StepId } from './StepIndicator';
import { SourceGrid } from './SourceGrid';
import { settingsApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// LocalStorage key + state shape
// ---------------------------------------------------------------------------

const LS_KEY = 'open-brain:onboarding';

interface OnboardingState {
  currentStep: StepId;
  completedSteps: StepId[];
  /** Step 1 form values */
  name: string;
  role: string;
  /** Step 2 selected source IDs */
  selectedSources: string[];
}

function loadState(): OnboardingState {
  if (typeof window === 'undefined') {
    return { currentStep: 1, completedSteps: [], name: '', role: '', selectedSources: [] };
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as OnboardingState;
  } catch {
    // corrupt storage — start fresh
  }
  return { currentStep: 1, completedSteps: [], name: '', role: '', selectedSources: [] };
}

function saveState(state: OnboardingState): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // storage full or blocked — non-fatal
  }
}

function clearState(): void {
  try {
    window.localStorage.removeItem(LS_KEY);
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Left editorial panel
// ---------------------------------------------------------------------------

function EditorialPanel() {
  return (
    <div
      className="hidden lg:flex flex-col justify-between p-12 xl:p-16"
      style={{
        background: `linear-gradient(160deg, var(--color-book-cloth) 0%, var(--color-book-cloth-dark) 60%, var(--color-clay) 100%)`,
        minWidth: 0,
        flexBasis: '42%',
        flexShrink: 0,
      }}
    >
      {/* Brand mark */}
      <div>
        <div className="flex items-center gap-2 mb-16">
          {/* Simple wordmark */}
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <rect width="28" height="28" rx="4" fill="rgba(255,255,255,0.15)" />
            <circle cx="14" cy="14" r="7" stroke="white" strokeWidth="1.5" fill="none" />
            <circle cx="14" cy="14" r="2.5" fill="white" />
            <line x1="14" y1="7" x2="14" y2="4" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="14" y1="21" x2="14" y2="24" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="14" x2="4" y2="14" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="21" y1="14" x2="24" y2="14" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span
            className="text-white font-semibold tracking-tight"
            style={{ fontFamily: 'var(--font-family-display)', fontSize: '18px' }}
          >
            Open Brain
          </span>
        </div>

        {/* Brand statement */}
        <h1
          className="text-white leading-tight mb-6"
          style={{
            fontFamily: 'var(--font-family-display)',
            fontSize: 'clamp(28px, 3vw, 42px)',
            fontWeight: 700,
            letterSpacing: '-0.025em',
            lineHeight: 1.15,
          }}
        >
          Your knowledge,<br />
          finally in<br />
          one place.
        </h1>

        <p
          className="leading-relaxed mb-10"
          style={{
            color: 'rgba(255,255,255,0.78)',
            fontSize: '15px',
            maxWidth: '340px',
          }}
        >
          Open Brain captures what you know — voice memos, emails, Slack threads,
          documents — and surfaces it when you need it.
        </p>

        {/* Pull-quote */}
        <blockquote
          className="pl-4 py-1"
          style={{
            borderLeft: '3px solid rgba(255,255,255,0.4)',
            color: 'rgba(255,255,255,0.65)',
            fontStyle: 'italic',
            fontSize: '13px',
            lineHeight: '1.6',
            maxWidth: '320px',
          }}
        >
          &ldquo;The best knowledge system is the one you actually use.&rdquo;
        </blockquote>
      </div>

      {/* Privacy footer */}
      <footer>
        <div
          className="pt-6"
          style={{ borderTop: '1px solid rgba(255,255,255,0.2)' }}
        >
          <div className="flex items-start gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="rgba(255,255,255,0.55)" aria-hidden="true" className="mt-0.5 flex-shrink-0">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
            </svg>
            <p
              className="text-[12px] leading-relaxed"
              style={{ color: 'rgba(255,255,255,0.55)', margin: 0 }}
            >
              Self-hosted and private. Your data never leaves your infrastructure.
              No telemetry. No third-party AI without your explicit routing config.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Introduce yourself
// ---------------------------------------------------------------------------

interface Step1Props {
  name: string;
  role: string;
  onNameChange: (v: string) => void;
  onRoleChange: (v: string) => void;
  onNext: () => void;
  isSaving: boolean;
}

function Step1({ name, role, onNameChange, onRoleChange, onNext, isSaving }: Step1Props) {
  const canProceed = name.trim().length >= 1;

  return (
    <div className="flex flex-col gap-6">
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
          Introduce yourself
        </h2>
        <p style={{ color: 'var(--color-text-body-secondary)', margin: 0, fontSize: '14px' }}>
          This helps Open Brain personalise your briefs and capture labels.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {/* Name field */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="ob-name"
            className="text-[13px] font-semibold"
            style={{ color: 'var(--color-text-heading)' }}
          >
            Your name
          </label>
          <input
            id="ob-name"
            type="text"
            placeholder="Troy Davis"
            autoFocus
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full px-3 py-2 text-[14px] transition-colors duration-150"
            style={{
              background: 'var(--color-bg-input)',
              border: '1px solid var(--color-border-input)',
              borderRadius: 'var(--border-radius-input)',
              color: 'var(--color-text-body)',
              outline: 'none',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-input-focused)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-input)';
            }}
          />
        </div>

        {/* Role field */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="ob-role"
            className="text-[13px] font-semibold"
            style={{ color: 'var(--color-text-heading)' }}
          >
            Your role
            <span
              className="ml-1 font-normal text-[12px]"
              style={{ color: 'var(--color-text-small)' }}
            >
              (optional)
            </span>
          </label>
          <input
            id="ob-role"
            type="text"
            placeholder="Senior consultant, builder, entrepreneur…"
            value={role}
            onChange={(e) => onRoleChange(e.target.value)}
            className="w-full px-3 py-2 text-[14px] transition-colors duration-150"
            style={{
              background: 'var(--color-bg-input)',
              border: '1px solid var(--color-border-input)',
              borderRadius: 'var(--border-radius-input)',
              color: 'var(--color-text-body)',
              outline: 'none',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-input-focused)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-input)';
            }}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={!canProceed || isSaving}
        className="self-start flex items-center gap-2 px-6 py-2.5 text-[14px] font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          backgroundColor: 'var(--color-button-primary-bg)',
          color: 'var(--color-button-primary-text)',
          borderRadius: 'var(--border-radius-button)',
          border: 'none',
          cursor: canProceed && !isSaving ? 'pointer' : undefined,
        }}
        onMouseEnter={(e) => {
          if (canProceed && !isSaving) {
            e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg-hover)';
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg)';
        }}
      >
        {isSaving ? (
          <>
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="3" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="white" strokeWidth="3" strokeLinecap="round" />
            </svg>
            Saving…
          </>
        ) : (
          <>
            Continue
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
            </svg>
          </>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Connect sources
// ---------------------------------------------------------------------------

interface Step2Props {
  selectedSources: Set<string>;
  onToggle: (id: string) => void;
  onNext: () => void;
  onBack: () => void;
}

function Step2({ selectedSources, onToggle, onNext, onBack }: Step2Props) {
  return (
    <div className="flex flex-col gap-6">
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
          Connect your first source
        </h2>
        <p style={{ color: 'var(--color-text-body-secondary)', margin: 0, fontSize: '14px' }}>
          Select the sources you want to capture from. Click a card to see setup instructions.
        </p>
      </div>

      <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 380px)' }}>
        <SourceGrid selected={selectedSources} onToggle={onToggle} />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-colors duration-150"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-cloud-medium)',
            color: 'var(--color-text-body)',
            borderRadius: 'var(--border-radius-button)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-ivory-medium)';
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
          onClick={onNext}
          className="flex items-center gap-2 px-6 py-2.5 text-[14px] font-semibold transition-colors duration-150"
          style={{
            backgroundColor: 'var(--color-button-primary-bg)',
            color: 'var(--color-button-primary-text)',
            borderRadius: 'var(--border-radius-button)',
            border: 'none',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg)';
          }}
        >
          Continue
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onNext}
          className="text-[13px] transition-colors duration-150"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-small)',
            cursor: 'pointer',
            padding: '0 4px',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-body)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-small)'; }}
        >
          Skip — I&apos;ll capture manually
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Placeholder steps 3 & 4 (implemented in 3.5)
// ---------------------------------------------------------------------------

interface StubStepProps {
  title: string;
  description: string;
  onNext: () => void;
  onBack: () => void;
  nextLabel?: string;
  isLast?: boolean;
}

function StubStep({ title, description, onNext, onBack, nextLabel = 'Continue', isLast }: StubStepProps) {
  return (
    <div className="flex flex-col gap-6">
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
          {title}
        </h2>
        <p style={{ color: 'var(--color-text-body-secondary)', margin: 0, fontSize: '14px' }}>
          {description}
        </p>
      </div>

      {/* Placeholder card */}
      <div
        className="p-8 text-center rounded-sm"
        style={{
          border: '2px dashed var(--color-border-divider)',
          color: 'var(--color-text-small)',
        }}
      >
        <p className="text-[13px]">This step is coming in the next release.</p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-colors duration-150"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-cloud-medium)',
            color: 'var(--color-text-body)',
            borderRadius: 'var(--border-radius-button)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-ivory-medium)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
          </svg>
          Back
        </button>

        <button
          type="button"
          onClick={onNext}
          className="flex items-center gap-2 px-6 py-2.5 text-[14px] font-semibold transition-colors duration-150"
          style={{
            backgroundColor: isLast ? 'var(--color-success)' : 'var(--color-button-primary-bg)',
            color: 'white',
            borderRadius: 'var(--border-radius-button)',
            border: 'none',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            if (!isLast) e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg-hover)';
          }}
          onMouseLeave={(e) => {
            if (!isLast) e.currentTarget.style.backgroundColor = 'var(--color-button-primary-bg)';
          }}
        >
          {nextLabel}
          {!isLast && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OnboardingWizard — root client component
// ---------------------------------------------------------------------------

/**
 * OnboardingWizard — full-bleed 2-panel onboarding experience.
 *
 * Left panel: editorial book-cloth panel (brand statement, pull-quote, privacy footer).
 * Right panel: step wizard with StepIndicator + step content.
 *
 * Step state persisted to localStorage — survives refresh, resumes where left off.
 */
export function OnboardingWizard() {
  const router = useRouter();

  // Hydrate from localStorage after mount to avoid SSR mismatch
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<OnboardingState>({
    currentStep: 1,
    completedSteps: [],
    name: '',
    role: '',
    selectedSources: [],
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loaded = loadState();
    setState(loaded);
    setHydrated(true);
  }, []);

  // Persist on every state change (after hydration)
  useEffect(() => {
    if (hydrated) saveState(state);
  }, [state, hydrated]);

  const completedSet = new Set<StepId>(state.completedSteps);

  const goToStep = useCallback((step: StepId) => {
    setState((prev) => ({ ...prev, currentStep: step }));
  }, []);

  const markComplete = useCallback((step: StepId) => {
    setState((prev) => ({
      ...prev,
      completedSteps: prev.completedSteps.includes(step)
        ? prev.completedSteps
        : [...prev.completedSteps, step],
    }));
  }, []);

  // --- Step 1 handlers ---
  const handleStep1Next = useCallback(async () => {
    setError(null);
    setIsSaving(true);
    try {
      await settingsApi.put('user_profile', { name: state.name.trim(), role: state.role.trim() });
      markComplete(1);
      goToStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [state.name, state.role, markComplete, goToStep]);

  // --- Step 2 handlers ---
  const handleSourceToggle = useCallback((id: string) => {
    setState((prev) => {
      const next = new Set(prev.selectedSources);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { ...prev, selectedSources: Array.from(next) };
    });
  }, []);

  const handleStep2Next = useCallback(() => {
    markComplete(2);
    goToStep(3);
  }, [markComplete, goToStep]);

  // --- Step 3 handlers ---
  const handleStep3Next = useCallback(() => {
    markComplete(3);
    goToStep(4);
  }, [markComplete, goToStep]);

  // --- Step 4 (finish) ---
  const handleFinish = useCallback(async () => {
    setError(null);
    setIsSaving(true);
    try {
      await settingsApi.put('onboarding_completed', true);
      markComplete(4);
      clearState();
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete setup. Please try again.');
      setIsSaving(false);
    }
  }, [markComplete, router]);

  if (!hydrated) {
    // Avoid flash of wrong step — render skeleton until localStorage loads
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div
          className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{
            borderColor: 'var(--color-cloud-light)',
            borderTopColor: 'var(--color-book-cloth)',
          }}
          aria-label="Loading"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Left: editorial panel (hidden on small screens) */}
      <EditorialPanel />

      {/* Right: wizard area */}
      <div
        className="flex-1 flex flex-col min-h-screen overflow-y-auto"
        style={{ backgroundColor: 'var(--color-ivory-light)' }}
      >
        {/* Inner content — centered vertically, capped width */}
        <div className="flex flex-col flex-1 px-8 py-10 sm:px-12 lg:px-16 max-w-[600px] w-full mx-auto">
          {/* Step indicator at top */}
          <div className="mb-10">
            <StepIndicator
              currentStep={state.currentStep}
              completedSteps={completedSet}
            />
          </div>

          {/* Error banner */}
          {error && (
            <div
              className="mb-6 px-4 py-3 text-[13px] rounded-sm"
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

          {/* Step content */}
          <div className="flex-1">
            {state.currentStep === 1 && (
              <Step1
                name={state.name}
                role={state.role}
                onNameChange={(v) => setState((prev) => ({ ...prev, name: v }))}
                onRoleChange={(v) => setState((prev) => ({ ...prev, role: v }))}
                onNext={handleStep1Next}
                isSaving={isSaving}
              />
            )}

            {state.currentStep === 2 && (
              <Step2
                selectedSources={new Set(state.selectedSources)}
                onToggle={handleSourceToggle}
                onNext={handleStep2Next}
                onBack={() => goToStep(1)}
              />
            )}

            {state.currentStep === 3 && (
              <StubStep
                title="Choose a capture habit"
                description="Select the cadence that fits how you think — we'll remind you at the right moments."
                onNext={handleStep3Next}
                onBack={() => goToStep(2)}
              />
            )}

            {state.currentStep === 4 && (
              <StubStep
                title="Shape your first brief"
                description="We'll generate your first brief once you've captured a few thoughts."
                onNext={handleFinish}
                onBack={() => goToStep(3)}
                nextLabel={isSaving ? 'Finishing…' : 'Finish setup'}
                isLast
              />
            )}
          </div>

          {/* Footer spacer */}
          <div className="pt-8">
            <p
              className="text-center text-[11px]"
              style={{ color: 'var(--color-text-small)' }}
            >
              Open Brain — self-hosted personal AI. Step {state.currentStep} of 4.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
