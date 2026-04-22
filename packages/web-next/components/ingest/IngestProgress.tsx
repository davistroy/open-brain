'use client';

/**
 * IngestProgress — SSE-driven progress tracker for an in-flight file upload.
 *
 * Subscribes to GET /api/v1/events (global SSE stream) and filters for
 * `upload:status` events matching the given upload_id. Shows pipeline stages
 * visually with a step indicator.
 *
 * The global events stream uses the CHANNEL_TO_SSE_EVENT mapping in
 * packages/core-api/src/routes/events.ts: pg_notify channel `upload_status`
 * maps to SSE event name `upload:status`.
 *
 * SSE event payload shape (discriminated union):
 *   { type: 'started', upload_id, filename, source_type, size_bytes, at }
 *   { type: 'progress', upload_id, filename, source_type, status, message?, at }
 *   { type: 'completed', upload_id, filename, source_type, status: 'parsed',
 *       capture_ids, duration_ms, at }
 *   { type: 'failed', upload_id, filename, source_type, status: 'failed',
 *       error_message, duration_ms?, at }
 */

import { useEffect, useState, useRef } from 'react';
import { CheckCircle, Loader2, AlertCircle, Clock } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StageStatus = 'waiting' | 'active' | 'done' | 'error';

interface Stage {
  id: string;
  label: string;
  status: StageStatus;
}

interface UploadProgressPayload {
  type: 'started' | 'progress' | 'completed' | 'failed';
  upload_id: string;
  filename: string;
  source_type: string;
  status?: string;
  message?: string;
  capture_ids?: string[];
  duration_ms?: number;
  error_message?: string;
  at: string;
}

type ProgressState =
  | { phase: 'idle' }
  | { phase: 'tracking'; uploadId: string; filename: string; stages: Stage[]; captureIds?: string[] }
  | { phase: 'complete'; uploadId: string; filename: string; captureIds: string[]; durationMs: number }
  | { phase: 'failed'; uploadId: string; filename: string; errorMessage: string };

interface IngestProgressProps {
  uploadId: string | null;
  filename: string | null;
  onComplete?: (captureIds: string[]) => void;
}

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

const INITIAL_STAGES: Stage[] = [
  { id: 'queued',     label: 'Queued',    status: 'waiting' },
  { id: 'processing', label: 'Processing', status: 'waiting' },
  { id: 'parsed',     label: 'Parsed',    status: 'waiting' },
  { id: 'complete',   label: 'Complete',  status: 'waiting' },
];

function stageIndexForStatus(status: string): number {
  switch (status) {
    case 'pending':    return 0;
    case 'processing': return 1;
    case 'parsed':     return 2;
    default:           return -1;
  }
}

function buildStages(status: string, hasError: boolean): Stage[] {
  const activeIdx = stageIndexForStatus(status);
  return INITIAL_STAGES.map((stage, i) => {
    if (hasError && i >= activeIdx) return { ...stage, status: i === activeIdx ? 'error' as StageStatus : 'waiting' as StageStatus };
    if (status === 'parsed' && i <= 3) return { ...stage, status: 'done' as StageStatus };
    if (i < activeIdx) return { ...stage, status: 'done' as StageStatus };
    if (i === activeIdx) return { ...stage, status: 'active' as StageStatus };
    return { ...stage, status: 'waiting' as StageStatus };
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IngestProgress({ uploadId, filename, onComplete }: IngestProgressProps) {
  const [progressState, setProgressState] = useState<ProgressState>({ phase: 'idle' });
  const eventSourceRef = useRef<EventSource | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!uploadId || !filename) {
      setProgressState({ phase: 'idle' });
      return;
    }

    // Initialize tracking state
    setProgressState({
      phase: 'tracking',
      uploadId,
      filename,
      stages: INITIAL_STAGES.map((s, i) => ({
        ...s,
        status: i === 0 ? 'active' : 'waiting',
      })),
    });

    // Open the global SSE stream
    const es = new EventSource('/api/v1/events');
    eventSourceRef.current = es;

    es.addEventListener('upload:status', (e: MessageEvent) => {
      let payload: UploadProgressPayload;
      try {
        payload = JSON.parse(e.data as string) as UploadProgressPayload;
      } catch {
        return;
      }

      // Only process events for our upload
      if (payload.upload_id !== uploadId) return;

      if (payload.type === 'completed') {
        const captureIds = payload.capture_ids ?? [];
        const durationMs = payload.duration_ms ?? 0;
        setProgressState({ phase: 'complete', uploadId, filename, captureIds, durationMs });
        onCompleteRef.current?.(captureIds);
        es.close();
      } else if (payload.type === 'failed') {
        setProgressState({
          phase: 'failed',
          uploadId,
          filename,
          errorMessage: payload.error_message ?? 'Processing failed',
        });
        es.close();
      } else if (payload.type === 'progress' || payload.type === 'started') {
        const status = payload.status ?? 'pending';
        setProgressState({
          phase: 'tracking',
          uploadId,
          filename,
          stages: buildStages(status, false),
        });
      }
    });

    es.onerror = () => {
      // SSE errors are transient (reconnect happens automatically).
      // Only set error state if we never got a completion.
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [uploadId, filename]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (progressState.phase === 'idle') return null;

  if (progressState.phase === 'complete') {
    return (
      <div className="rounded-[4px] border border-[var(--color-rule)] bg-[#f9f7f4] p-5">
        <div className="flex items-start gap-3">
          <CheckCircle size={18} strokeWidth={1.4} className="text-[#5c7a5c] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-display text-[14px] text-[var(--color-text-body)] mb-0.5">
              Processing complete
            </p>
            <p className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--color-text-body-secondary)]">
              {progressState.filename}
              {progressState.captureIds.length > 0 && (
                <> · {progressState.captureIds.length} capture{progressState.captureIds.length !== 1 ? 's' : ''} created</>
              )}
              {progressState.durationMs > 0 && (
                <> · {(progressState.durationMs / 1000).toFixed(1)}s</>
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (progressState.phase === 'failed') {
    return (
      <div className="rounded-[4px] border border-[var(--color-rule)] bg-[#faf7f4] p-5">
        <div className="flex items-start gap-3">
          <AlertCircle size={18} strokeWidth={1.4} className="text-[#b05040] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-display text-[14px] text-[var(--color-text-body)] mb-0.5">
              Processing failed
            </p>
            <p className="text-[12.5px] text-[var(--color-text-body-secondary)]">
              {progressState.errorMessage}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // phase === 'tracking'
  const { stages } = progressState;

  return (
    <div className="rounded-[4px] border border-[var(--color-rule)] bg-[#faf8f5] p-5">
      <div className="flex items-center gap-2 mb-4">
        <Loader2 size={14} strokeWidth={1.6} className="text-[var(--color-book-cloth)] animate-spin shrink-0" />
        <p className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--color-text-body-secondary)] truncate">
          {progressState.filename}
        </p>
      </div>

      {/* Stage steps */}
      <div className="flex items-center gap-0">
        {stages.map((stage, i) => (
          <div key={stage.id} className="flex items-center flex-1 min-w-0">
            {/* Step indicator */}
            <div className="flex flex-col items-center shrink-0">
              <div
                className={[
                  'w-6 h-6 rounded-full flex items-center justify-center border transition-colors duration-200',
                  stage.status === 'done'
                    ? 'bg-[#5c7a5c] border-[#5c7a5c]'
                    : stage.status === 'active'
                      ? 'bg-[var(--color-book-cloth)] border-[var(--color-book-cloth)]'
                      : stage.status === 'error'
                        ? 'bg-[#b05040] border-[#b05040]'
                        : 'bg-transparent border-[var(--color-rule)]',
                ].join(' ')}
              >
                {stage.status === 'done' && (
                  <CheckCircle size={12} strokeWidth={2} className="text-white" />
                )}
                {stage.status === 'active' && (
                  <Loader2 size={11} strokeWidth={2} className="text-white animate-spin" />
                )}
                {stage.status === 'error' && (
                  <AlertCircle size={12} strokeWidth={2} className="text-white" />
                )}
                {stage.status === 'waiting' && (
                  <Clock size={11} strokeWidth={1.5} className="text-[var(--color-text-body-secondary)]" />
                )}
              </div>
              <span
                className={[
                  'mt-1.5 font-mono text-[9.5px] uppercase tracking-wider whitespace-nowrap',
                  stage.status === 'active'
                    ? 'text-[var(--color-book-cloth)]'
                    : stage.status === 'done'
                      ? 'text-[#5c7a5c]'
                      : stage.status === 'error'
                        ? 'text-[#b05040]'
                        : 'text-[var(--color-text-body-secondary)]',
                ].join(' ')}
              >
                {stage.label}
              </span>
            </div>

            {/* Connector line */}
            {i < stages.length - 1 && (
              <div
                className={[
                  'flex-1 h-[1px] mx-1 mt-[-14px] transition-colors duration-300',
                  stage.status === 'done' ? 'bg-[#5c7a5c]' : 'bg-[var(--color-rule)]',
                ].join(' ')}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
