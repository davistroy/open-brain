'use client';

/**
 * DangerZoneSection — Settings → Danger zone.
 *
 * Implements the two-step admin reset flow matching POST /api/v1/admin/reset-data:
 *   Step 1: POST with no body → receive { token, expires_in, message }
 *   Step 2: POST with { confirm: "WIPE ALL DATA", token } → wipe executed
 *
 * Origin allowlist: brain.troy-davis.com only. Displays a warning if the
 * current URL is not in the allowlist (step 1 will 403 in that case).
 *
 * No adminAuth() — protection is: origin check + two-step token +
 * confirmation phrase + rate limiter. Do not add Bearer auth here.
 *
 * Per CLAUDE.md: fail-closed on NODE_ENV — only explicit development/test
 * bypasses origin check on the server side.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { TriangleAlert, Trash2, ShieldAlert, RefreshCw, CheckCircle2, Clock } from 'lucide-react';
import { Button } from '@/components/design-system/Button';

// Token TTL in seconds — mirrors the 5-minute single-use Redis key TTL on the server.
const TOKEN_TTL_SECONDS = 5 * 60;

/** Format seconds as M:SS for the countdown display. */
function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** CountdownTimer — ticks down from initialSeconds, calls onExpired at 0. */
function CountdownTimer({
  initialSeconds,
  onExpired,
}: {
  initialSeconds: number;
  onExpired?: () => void;
}) {
  const [remaining, setRemaining] = useState(initialSeconds);
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;

  useEffect(() => {
    if (remaining <= 0) {
      onExpiredRef.current?.();
      return;
    }
    const id = setTimeout(() => setRemaining(r => r - 1), 1_000);
    return () => clearTimeout(id);
  }, [remaining]);

  const isExpired = remaining <= 0;
  const isUrgent = remaining > 0 && remaining <= 60;

  return (
    <span
      className={[
        'inline-flex items-center gap-1 font-mono text-[12px] tabular-nums',
        isExpired
          ? 'text-[var(--color-status-error-fg)]'
          : isUrgent
            ? 'text-[var(--color-faded-red)]'
            : 'text-text-body-secondary',
      ].join(' ')}
      aria-live="polite"
      aria-atomic="true"
    >
      <Clock size={11} strokeWidth={1.5} className="shrink-0" />
      {isExpired ? 'Token expired' : formatCountdown(remaining)}
    </span>
  );
}

// Origin allowlist (mirrors server-side ALLOWED_ORIGINS).
// Warning is informational only — the server performs the authoritative check.
const ALLOWED_ORIGINS = new Set(['https://brain.troy-davis.com']);

const CONFIRMATION_PHRASE = 'WIPE ALL DATA';

type ResetStep = 'idle' | 'confirm-open' | 'step1-pending' | 'step2-ready' | 'step2-pending' | 'complete' | 'error';

interface ResetState {
  step: ResetStep;
  token?: string;
  expiresIn?: number;         // server-reported TTL in seconds
  error?: string;
  phraseInput: string;
  clearedTables?: string[];
  auditId?: string;
}

function isOriginAllowed(): boolean {
  if (typeof window === 'undefined') return true; // SSR — skip check
  const origin = window.location.origin;
  return ALLOWED_ORIGINS.has(origin);
}

async function adminPost<T>(body?: object): Promise<T> {
  const res = await fetch('/api/v1/admin/reset-data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Open-Brain-Caller': 'web-ui',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json() as T;

  if (!res.ok) {
    const errData = data as { error?: string };
    throw new Error(errData.error ?? `HTTP ${res.status}`);
  }

  return data;
}

export function DangerZoneSection() {
  const [state, setState] = useState<ResetState>({ step: 'idle', phraseInput: '' });
  const [tokenIssuedAt, setTokenIssuedAt] = useState<number | null>(null);
  const phraseInputRef = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback((el: HTMLInputElement | null) => { phraseInputRef.current = el; }, []);
  const originOk = isOriginAllowed();

  // ── Step 1: request reset token ───────────────────────────────────────────
  async function handleStep1() {
    setState(prev => ({ ...prev, step: 'step1-pending', error: undefined }));
    try {
      const res = await adminPost<{ token: string; expires_in: number; message: string }>();
      setTokenIssuedAt(Date.now());
      setState(prev => ({
        ...prev,
        step: 'step2-ready',
        token: res.token,
        expiresIn: res.expires_in ?? TOKEN_TTL_SECONDS,
        phraseInput: '',
      }));
      // Focus phrase input after render
      setTimeout(() => phraseInputRef.current?.focus(), 50);
    } catch (err) {
      setState(prev => ({
        ...prev,
        step: 'error',
        error: err instanceof Error ? err.message : 'Unknown error requesting reset token.',
      }));
    }
  }

  // ── Step 2: confirm with phrase + token ───────────────────────────────────
  async function handleStep2() {
    if (state.phraseInput !== CONFIRMATION_PHRASE) return;
    setState(prev => ({ ...prev, step: 'step2-pending', error: undefined }));
    try {
      const res = await adminPost<{
        cleared: string[];
        preserved: string[];
        wiped_at: string;
        backup_path: string;
        audit_id: string;
      }>({ confirm: CONFIRMATION_PHRASE, token: state.token });

      setState(prev => ({
        ...prev,
        step: 'complete',
        clearedTables: res.cleared,
        auditId: res.audit_id,
        token: undefined,
      }));
      setTokenIssuedAt(null);
    } catch (err) {
      setState(prev => ({
        ...prev,
        step: 'error',
        error: err instanceof Error ? err.message : 'Unknown error during data reset.',
      }));
    }
  }

  function handleCancel() {
    setState({ step: 'idle', phraseInput: '' });
    setTokenIssuedAt(null);
  }

  function handleTokenExpired() {
    setState(prev => ({
      ...prev,
      step: 'error',
      error: 'Reset token expired. Request a new token to proceed.',
      token: undefined,
    }));
    setTokenIssuedAt(null);
  }

  const phraseMatch = state.phraseInput === CONFIRMATION_PHRASE;
  const isLoading = state.step === 'step1-pending' || state.step === 'step2-pending';

  return (
    <div className="bg-bg-container border border-cloud-light">
      {/* ── Section header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-8 py-5 border-b border-cloud-light">
        <div className="w-8 h-8 flex items-center justify-center border border-[var(--color-faded-red)] border-opacity-40 shrink-0">
          <TriangleAlert
            size={15}
            strokeWidth={1.4}
            className="text-[var(--color-faded-red)]"
          />
        </div>
        <h2 className="font-display text-[17px] font-normal tracking-[-0.01em] text-[var(--color-faded-red)]">
          Danger zone
        </h2>
      </div>

      {/* ── Origin warning (informational) ─────────────────────────────────── */}
      {!originOk && (
        <div
          className="flex items-start gap-3 mx-8 mt-6 px-4 py-3 bg-[var(--color-status-warning-bg)] border border-[var(--color-status-warning-border)]"
          role="alert"
        >
          <ShieldAlert
            size={14}
            strokeWidth={1.5}
            className="text-[var(--color-status-warning-fg)] shrink-0 mt-[1px]"
          />
          <p className="text-[12.5px] text-[var(--color-status-warning-fg)] font-light leading-[1.5]">
            <strong className="font-medium">Origin mismatch.</strong> This page is not served from{' '}
            <code className="font-mono text-[11.5px]">brain.troy-davis.com</code>. The server will
            reject the reset request with 403 Forbidden. Open this page from the production URL to
            proceed.
          </p>
        </div>
      )}

      {/* ── Reset action card ──────────────────────────────────────────────── */}
      <div className="px-8 py-6">
        {/* ── Complete state ──────────────────────────────────────────────── */}
        {state.step === 'complete' && (
          <div
            className="flex items-start gap-3 px-4 py-4 border border-cloud-light bg-[var(--color-ivory-medium)]"
            role="status"
          >
            <CheckCircle2
              size={16}
              strokeWidth={1.5}
              className="text-[var(--color-status-success-fg)] shrink-0 mt-[1px]"
            />
            <div className="flex flex-col gap-1">
              <p className="text-[13px] font-medium text-text-heading">Data wiped successfully.</p>
              <p className="text-[12.5px] text-text-body-secondary font-light leading-[1.5]">
                {state.clearedTables?.length ?? 0} tables cleared. Audit record{' '}
                <code className="font-mono text-[11px]">{state.auditId}</code> written. A pre-wipe
                backup was stored on the server.
              </p>
              <button
                type="button"
                onClick={handleCancel}
                className="mt-2 text-[12px] text-text-body-secondary underline underline-offset-2 hover:text-text-heading text-left w-fit"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* ── Error state ─────────────────────────────────────────────────── */}
        {state.step === 'error' && (
          <div
            className="flex items-start gap-3 mb-5 px-4 py-3 border border-[var(--color-status-error-border)] bg-[var(--color-status-error-bg)]"
            role="alert"
          >
            <TriangleAlert
              size={14}
              strokeWidth={1.5}
              className="text-[var(--color-status-error-fg)] shrink-0 mt-[1px]"
            />
            <div className="flex flex-col gap-1">
              <p className="text-[12.5px] font-medium text-[var(--color-status-error-fg)]">
                Reset failed
              </p>
              <p className="text-[12px] text-[var(--color-status-error-fg)] font-light">
                {state.error}
              </p>
            </div>
          </div>
        )}

        {/* ── Idle / confirmation dialog ─────────────────────────────────── */}
        {state.step !== 'complete' && (
          <div className="flex flex-col gap-5">
            {/* Action description */}
            <div className="flex items-start gap-4 p-5 border border-[var(--color-faded-red)] border-opacity-30">
              <Trash2
                size={18}
                strokeWidth={1.2}
                className="text-[var(--color-faded-red)] shrink-0 mt-[2px] opacity-70"
              />
              <div className="flex flex-col gap-1 flex-1 min-w-0">
                <p className="text-[13.5px] font-medium text-text-heading">Reset all data</p>
                <p className="text-[12.5px] text-text-body-secondary font-light leading-[1.6]">
                  Permanently delete all captures, entities, pipeline events, sessions, briefs, and
                  AI audit logs. The system schema, app settings, and admin audit trail are
                  preserved. A pre-wipe PostgreSQL backup is taken automatically before the tables
                  are truncated. This action cannot be undone.
                </p>

                {/* Step 1: initial button */}
                {(state.step === 'idle' || state.step === 'error') && (
                  <div className="mt-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setState(prev => ({ ...prev, step: 'confirm-open', error: undefined }))}
                      disabled={!originOk}
                      icon={<Trash2 size={12} strokeWidth={1.5} />}
                      className="border-[var(--color-faded-red)] border-opacity-60 text-[var(--color-faded-red)] hover:bg-[var(--color-status-error-bg)]"
                    >
                      Reset all data&hellip;
                    </Button>
                  </div>
                )}

                {/* Confirmation panel — step 1 confirm + step 2 phrase entry */}
                {(state.step === 'confirm-open' || state.step === 'step1-pending' || state.step === 'step2-ready' || state.step === 'step2-pending') && (
                  <div className="mt-4 flex flex-col gap-4 pt-4 border-t border-cloud-light">
                    {/* Step 2: enter confirmation phrase */}
                    {(state.step === 'step2-ready' || state.step === 'step2-pending') ? (
                      <>
                        <div className="flex items-center justify-between gap-4">
                          <p className="text-[12.5px] text-text-body-secondary font-light leading-[1.5]">
                            A single-use token has been issued. Type the confirmation phrase below
                            exactly to proceed.
                          </p>
                          {tokenIssuedAt !== null && (
                            <CountdownTimer
                              key={tokenIssuedAt}
                              initialSeconds={state.expiresIn ?? TOKEN_TTL_SECONDS}
                              onExpired={handleTokenExpired}
                            />
                          )}
                        </div>

                        <div className="flex flex-col gap-[5px] max-w-[360px]">
                          <label
                            htmlFor="danger-phrase-input"
                            className="font-body text-[12.5px] font-normal text-text-body-secondary tracking-[0.005em]"
                          >
                            Type &ldquo;{CONFIRMATION_PHRASE}&rdquo; to confirm
                          </label>
                          <input
                            id="danger-phrase-input"
                            ref={setRef}
                            type="text"
                            placeholder={CONFIRMATION_PHRASE}
                            value={state.phraseInput}
                            onChange={e =>
                              setState(prev => ({ ...prev, phraseInput: e.target.value }))
                            }
                            onKeyDown={e => {
                              if (e.key === 'Enter' && phraseMatch && !isLoading) {
                                void handleStep2();
                              }
                            }}
                            disabled={isLoading}
                            autoComplete="off"
                            spellCheck={false}
                            aria-describedby="danger-phrase-hint"
                            className={[
                              'w-full h-[30px]',
                              'bg-bg-container border rounded-none',
                              'font-body text-[13px] font-light text-text-body',
                              'pl-[12px] pr-[12px]',
                              'outline-none',
                              'focus:border-slate-medium',
                              'transition-[border-color] duration-[120ms]',
                              'disabled:opacity-50 disabled:cursor-not-allowed',
                              phraseMatch
                                ? 'border-[var(--color-status-success-fg)]'
                                : 'border-cloud-medium',
                            ].filter(Boolean).join(' ')}
                          />
                        </div>
                        <p
                          id="danger-phrase-hint"
                          className="text-[11.5px] text-text-body-secondary font-light -mt-2"
                        >
                          {phraseMatch
                            ? 'Phrase accepted — click Confirm reset to execute the wipe.'
                            : `${state.phraseInput.length > 0 ? 'Phrase does not match.' : 'Phrase required.'}`}
                        </p>

                        <div className="flex items-center gap-3">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void handleStep2()}
                            disabled={!phraseMatch || isLoading}
                            icon={
                              isLoading ? (
                                <RefreshCw size={12} strokeWidth={1.5} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} strokeWidth={1.5} />
                              )
                            }
                            className="bg-[var(--color-faded-red)] border-[var(--color-faded-red)] hover:opacity-90"
                          >
                            {isLoading ? 'Wiping data…' : 'Confirm reset'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCancel}
                            disabled={isLoading}
                          >
                            Cancel
                          </Button>
                        </div>
                      </>
                    ) : (
                      /* Step 1: request the token */
                      <>
                        <div
                          className="flex items-start gap-2 px-3 py-2 bg-[var(--color-status-error-bg)] border border-[var(--color-status-error-border)]"
                          role="alert"
                        >
                          <ShieldAlert
                            size={13}
                            strokeWidth={1.5}
                            className="text-[var(--color-status-error-fg)] shrink-0 mt-[2px]"
                          />
                          <p className="text-[12px] text-[var(--color-status-error-fg)] font-light leading-[1.5]">
                            <strong className="font-medium">This is irreversible.</strong> All captures,
                            entities, sessions, and AI history will be permanently deleted. Proceed only
                            if you intend to start fresh.
                          </p>
                        </div>

                        <div className="flex items-center gap-3">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleStep1()}
                            disabled={isLoading || !originOk}
                            icon={
                              isLoading ? (
                                <RefreshCw size={12} strokeWidth={1.5} className="animate-spin" />
                              ) : undefined
                            }
                            className="border-[var(--color-faded-red)] border-opacity-60 text-[var(--color-faded-red)]"
                          >
                            {isLoading ? 'Requesting token…' : 'I understand — proceed'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCancel}
                            disabled={isLoading}
                          >
                            Cancel
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
