'use client';

// ---------------------------------------------------------------------------
// FirstBriefStep — Step 4 (final) of the onboarding wizard
//
// Shows a brief preview if captures exist (triggers daily-brief skill), or
// renders a static sample brief if the brain is empty. "Finish setup" button
// writes onboarding_completed=true then redirects to /dashboard via the
// wizard's onFinish handler.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { statsApi, skillsApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Sample brief shown when total_captures = 0
// ---------------------------------------------------------------------------

function SampleBrief() {
  return (
    <div
      className="rounded-sm"
      style={{
        border: '1px solid var(--color-border-card)',
        background: 'var(--color-bg-surface)',
        overflow: 'hidden',
      }}
    >
      {/* Brief header */}
      <div
        className="px-5 py-4"
        style={{
          borderBottom: '1px solid var(--color-border-divider)',
          background: 'var(--color-ivory-medium)',
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <span
            className="text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: 'var(--color-book-cloth)' }}
          >
            Sample Brief
          </span>
        </div>
        <h3
          className="text-[15px] font-semibold"
          style={{
            fontFamily: 'var(--font-family-display)',
            color: 'var(--color-text-heading)',
            margin: 0,
          }}
        >
          Morning Brief — What a real brief looks like
        </h3>
        <p
          className="text-[12px] mt-1"
          style={{ color: 'var(--color-text-small)', margin: '4px 0 0' }}
        >
          Your actual briefs will draw from your captures, entities, and patterns.
        </p>
      </div>

      {/* Brief body */}
      <div className="px-5 py-4 flex flex-col gap-4">
        <section>
          <h4
            className="text-[12px] font-semibold uppercase tracking-wider mb-2"
            style={{ color: 'var(--color-text-small)', margin: '0 0 8px' }}
          >
            Today&apos;s focus
          </h4>
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: 'var(--color-text-body)', margin: 0 }}
          >
            Three decisions from yesterday are still open. The architecture review
            with the CGI team at 2pm is the critical path item. Ravi owes you a
            pricing memo — worth a quick follow-up.
          </p>
        </section>

        <section>
          <h4
            className="text-[12px] font-semibold uppercase tracking-wider mb-2"
            style={{ color: 'var(--color-text-small)', margin: '0 0 8px' }}
          >
            Key themes this week
          </h4>
          <ul
            className="text-[13px] leading-relaxed"
            style={{ color: 'var(--color-text-body)', margin: 0, paddingLeft: '18px' }}
          >
            <li>Infrastructure scaling decisions (4 captures)</li>
            <li>Client onboarding blockers (2 captures)</li>
            <li>Personal: sailing trip logistics (3 captures)</li>
          </ul>
        </section>

        <div
          className="flex items-center gap-2 text-[11px] italic"
          style={{ color: 'var(--color-text-small)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
          This is a sample — your first real brief generates after you add a few captures.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BriefTriggerCard — shown when captures exist; triggers the daily-brief skill
// ---------------------------------------------------------------------------

type TriggerState = 'idle' | 'triggering' | 'queued' | 'error';

function BriefTriggerCard() {
  const [triggerState, setTriggerState] = useState<TriggerState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleTrigger = async () => {
    if (triggerState !== 'idle') return;
    setTriggerState('triggering');
    setErrorMsg(null);
    try {
      await skillsApi.trigger('morning-brief');
      setTriggerState('queued');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to trigger brief generation.',
      );
      setTriggerState('error');
    }
  };

  return (
    <div
      className="rounded-sm p-5"
      style={{
        border: '1px solid var(--color-border-card)',
        background: 'var(--color-bg-surface)',
      }}
    >
      {triggerState === 'queued' ? (
        <div className="flex items-start gap-3">
          <div
            style={{
              flexShrink: 0,
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'var(--color-status-success-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--color-success)" aria-hidden="true">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
            </svg>
          </div>
          <div>
            <p
              className="text-[14px] font-semibold mb-0.5"
              style={{ color: 'var(--color-text-heading)', margin: '0 0 4px' }}
            >
              Brief generation queued
            </p>
            <p
              className="text-[12px]"
              style={{ color: 'var(--color-text-body-secondary)', margin: 0 }}
            >
              Your first brief is being generated from your captures. It&apos;ll appear in
              the Briefs section within a few minutes.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <p
              className="text-[14px] font-semibold mb-1"
              style={{ color: 'var(--color-text-heading)', margin: '0 0 4px' }}
            >
              You&apos;re ready for your first brief
            </p>
            <p
              className="text-[12px] leading-relaxed"
              style={{ color: 'var(--color-text-body-secondary)', margin: 0 }}
            >
              Open Brain has found captures in your brain. Generate your first morning
              brief now — it synthesises what you know into a readable summary.
            </p>
          </div>

          {triggerState === 'error' && errorMsg && (
            <div
              className="px-3 py-2 text-[12px] rounded-sm"
              style={{
                backgroundColor: 'var(--color-status-error-bg)',
                border: '1px solid var(--color-status-error-border)',
                color: 'var(--color-status-error-fg)',
              }}
              role="alert"
            >
              {errorMsg}
            </div>
          )}

          <button
            type="button"
            onClick={handleTrigger}
            disabled={triggerState === 'triggering'}
            className="self-start flex items-center gap-2 px-5 py-2 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              backgroundColor: 'var(--color-book-cloth)',
              color: 'white',
              borderRadius: 'var(--border-radius-button)',
              border: 'none',
              cursor: triggerState === 'triggering' ? undefined : 'pointer',
            }}
            onMouseEnter={(e) => {
              if (triggerState !== 'triggering') {
                e.currentTarget.style.backgroundColor = 'var(--color-book-cloth-dark)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--color-book-cloth)';
            }}
          >
            {triggerState === 'triggering' ? (
              <>
                <svg
                  className="animate-spin"
                  width="12"
                  height="12"
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
                Generating…
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
                </svg>
                {triggerState === 'error' ? 'Try again' : 'Generate my first brief'}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FirstBriefStep — exported component
// ---------------------------------------------------------------------------

export interface FirstBriefStepProps {
  onFinish: () => void;
  onBack: () => void;
  isSaving?: boolean;
}

export function FirstBriefStep({ onFinish, onBack, isSaving = false }: FirstBriefStepProps) {
  const [hasCaptures, setHasCaptures] = useState<boolean | null>(null);

  // Check if the brain has any captures — determines which preview to show.
  // Fail open: if stats API is unreachable, default to sample (safe path).
  useEffect(() => {
    let cancelled = false;
    statsApi
      .get()
      .then((stats) => {
        if (!cancelled) {
          setHasCaptures(stats.total_captures > 0);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // API unreachable — show sample brief (safe fallback)
          setHasCaptures(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          Shape your first brief
        </h2>
        <p style={{ color: 'var(--color-text-body-secondary)', margin: 0, fontSize: '14px' }}>
          Briefs synthesise everything you&apos;ve captured into a readable, actionable summary.
        </p>
      </div>

      {/* Brief preview area */}
      {hasCaptures === null ? (
        // Loading state — checking for captures
        <div
          className="p-8 flex items-center justify-center rounded-sm"
          style={{
            border: '1px solid var(--color-border-card)',
            background: 'var(--color-bg-surface)',
          }}
        >
          <div
            className="w-6 h-6 rounded-full border-2 animate-spin"
            style={{
              borderColor: 'var(--color-cloud-light)',
              borderTopColor: 'var(--color-book-cloth)',
            }}
            aria-label="Checking your brain…"
          />
        </div>
      ) : hasCaptures ? (
        <BriefTriggerCard />
      ) : (
        <SampleBrief />
      )}

      {/* Info callout */}
      <div
        className="flex items-start gap-3 px-4 py-3 rounded-sm"
        style={{
          background: 'var(--color-ivory-medium)',
          border: '1px solid var(--color-border-divider)',
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="var(--color-book-cloth)"
          aria-hidden="true"
          className="mt-0.5 flex-shrink-0"
        >
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
        </svg>
        <p
          className="text-[12px] leading-relaxed"
          style={{ color: 'var(--color-text-body-secondary)', margin: 0 }}
        >
          Briefs are generated automatically each morning. You can also trigger them manually
          from the Briefs page at any time.
        </p>
      </div>

      {/* Navigation */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-cloud-medium)',
            color: 'var(--color-text-body)',
            borderRadius: 'var(--border-radius-button)',
            cursor: isSaving ? undefined : 'pointer',
          }}
          onMouseEnter={(e) => {
            if (!isSaving) e.currentTarget.style.background = 'var(--color-ivory-medium)';
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
          onClick={onFinish}
          disabled={isSaving}
          className="flex items-center gap-2 px-6 py-2.5 text-[14px] font-semibold transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            backgroundColor: 'var(--color-success)',
            color: 'white',
            borderRadius: 'var(--border-radius-button)',
            border: 'none',
            cursor: isSaving ? undefined : 'pointer',
          }}
        >
          {isSaving ? (
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
              Finishing…
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
              Finish setup
            </>
          )}
        </button>
      </div>
    </div>
  );
}
