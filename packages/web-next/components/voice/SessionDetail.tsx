'use client';

/**
 * SessionDetail — right-pane client component for the VoiceConversations page.
 *
 * Shows:
 *   - Session metadata (date, duration, brain_view, capture count)
 *   - Summary block (if present)
 *   - Full transcript as a conversation thread
 *   - Linked captures (fetched individually by ID)
 *
 * Architecture:
 *   - `sessionId` prop drives a single `useQuery(['voice-session', id])` fetch.
 *   - Active sessions are re-fetched every 10 seconds (same refetchInterval as
 *     SessionList) so the transcript updates while the session is live.
 *   - Linked captures are batch-fetched via Promise.all on captures_created[].
 *     Keeps the capture fetching local to this component.
 */

import { useQuery } from '@tanstack/react-query';
import { Loader2, Mic2, User, Bot, FileText, Clock, Hash } from 'lucide-react';
import { useVoiceSession } from '@/lib/api/voice.hooks';
import { capturesApi, type VoiceSession, type TranscriptTurn } from '@/lib/api-client';
import type { Capture } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDateLong(isoString: string): string {
  return new Date(isoString).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ---------------------------------------------------------------------------
// MetaBlock — compact session metadata strip
// ---------------------------------------------------------------------------

interface MetaBlockProps {
  session: VoiceSession;
}

function MetaBlock({ session }: MetaBlockProps) {
  const items = [
    {
      icon: Clock,
      label: 'Started',
      value: formatDateLong(session.started_at),
    },
    {
      icon: Clock,
      label: 'Duration',
      value: formatDuration(session.duration_seconds),
    },
    {
      icon: Hash,
      label: 'Turns',
      value: session.turn_count !== null ? String(session.turn_count) : '—',
    },
    {
      icon: FileText,
      label: 'Captures',
      value: session.captures_created?.length
        ? String(session.captures_created.length)
        : '0',
    },
  ];

  return (
    <div className="flex flex-wrap gap-x-[24px] gap-y-[8px] px-[18px] py-[12px] border-b border-cloud-light bg-[var(--color-bg-container)]">
      {items.map(({ icon: Icon, label, value }) => (
        <div key={label} className="flex items-center gap-[6px]">
          <Icon size={11} strokeWidth={1.5} className="text-[var(--color-text-body-secondary)] shrink-0" />
          <span className="font-mono text-[10.5px] tracking-[0.04em] uppercase text-[var(--color-text-body-secondary)]">
            {label}:
          </span>
          <span className="font-mono text-[10.5px] tracking-[0.04em] text-[var(--color-text-body)]">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryBlock
// ---------------------------------------------------------------------------

interface SummaryBlockProps {
  summary: string;
}

function SummaryBlock({ summary }: SummaryBlockProps) {
  return (
    <div className="px-[18px] py-[14px] border-b border-cloud-light bg-[var(--color-ivory-light)]">
      <div className="font-mono text-[10.5px] tracking-[0.05em] uppercase text-[var(--color-text-body-secondary)] mb-[6px]">
        Summary
      </div>
      <p className="text-[13.5px] text-[var(--color-text-body)] font-light leading-[1.55]">
        {summary}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TranscriptTurnRow
// ---------------------------------------------------------------------------

interface TurnRowProps {
  turn: TranscriptTurn;
  index: number;
}

function TurnRow({ turn, index }: TurnRowProps) {
  const isUser = turn.role === 'user';

  return (
    <div
      className={[
        'flex gap-[10px] px-[18px] py-[10px] border-b border-cloud-light',
        isUser ? 'bg-transparent' : 'bg-[var(--color-bg-container)]',
      ].join(' ')}
    >
      {/* Role icon */}
      <div className="shrink-0 mt-[2px]">
        <div
          className={[
            'w-[22px] h-[22px] flex items-center justify-center border',
            isUser
              ? 'border-[var(--color-book-cloth)] text-[var(--color-book-cloth)]'
              : 'border-[var(--color-cloud-light)] text-[var(--color-text-body-secondary)]',
          ].join(' ')}
        >
          {isUser ? (
            <User size={11} strokeWidth={1.5} />
          ) : (
            <Bot size={11} strokeWidth={1.5} />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-[8px] mb-[3px]">
          <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-[var(--color-text-body-secondary)]">
            {isUser ? 'You' : 'Assistant'}
          </span>
          {turn.timestamp && (
            <span className="font-mono text-[10px] text-[var(--color-text-body-secondary)] opacity-60">
              {turn.timestamp}
            </span>
          )}
          <span className="font-mono text-[10px] text-[var(--color-text-body-secondary)] opacity-40">
            #{index + 1}
          </span>
        </div>
        <p className="text-[13px] text-[var(--color-text-body)] leading-[1.55] font-light whitespace-pre-wrap">
          {turn.content}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LinkedCaptures
// ---------------------------------------------------------------------------

interface LinkedCapturesProps {
  captureIds: string[];
}

function LinkedCaptures({ captureIds }: LinkedCapturesProps) {
  const { data: captures, isLoading } = useQuery<Capture[]>({
    queryKey: ['voice-session-captures', captureIds],
    queryFn: async () => {
      if (captureIds.length === 0) return [];
      // Batch-fetch all linked captures in parallel
      const results = await Promise.allSettled(
        captureIds.map((id) => capturesApi.get(id)),
      );
      return results
        .filter((r): r is PromiseFulfilledResult<Capture> => r.status === 'fulfilled')
        .map((r) => r.value);
    },
    enabled: captureIds.length > 0,
    staleTime: 60_000,
  });

  if (captureIds.length === 0) return null;

  return (
    <div>
      <div className="px-[18px] py-[10px] border-b border-cloud-light bg-[var(--color-bg-container)]">
        <span className="font-mono text-[10.5px] tracking-[0.05em] uppercase text-[var(--color-text-body-secondary)]">
          Linked captures ({captureIds.length})
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 px-[18px] py-4 text-[var(--color-text-body-secondary)]">
          <Loader2 size={13} strokeWidth={1.5} className="animate-spin shrink-0" />
          <span className="font-mono text-[11px] tracking-[0.04em] uppercase">Loading captures…</span>
        </div>
      ) : (
        <div>
          {(captures ?? []).map((capture: Capture) => (
            <div
              key={capture.id}
              className="px-[18px] py-[10px] border-b border-cloud-light last:border-b-0"
            >
              <div className="flex items-baseline gap-[8px] mb-[3px]">
                <span className="font-mono text-[10px] tracking-[0.05em] uppercase text-[var(--color-text-body-secondary)]">
                  {capture.capture_type}
                </span>
                <span className="font-mono text-[10px] text-[var(--color-text-body-secondary)] opacity-60">
                  {new Date(capture.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
              <p className="text-[13px] text-[var(--color-text-body)] font-light leading-[1.5] line-clamp-3">
                {capture.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionDetail
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  sessionId: string;
  /** Whether this session is known-active (drives polling interval) */
  isActive?: boolean;
}

export function SessionDetail({ sessionId, isActive = false }: SessionDetailProps) {
  const { data: session, isLoading, isError, error } = useVoiceSession(sessionId, { isActive });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[var(--color-text-body-secondary)]">
        <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />
        <span className="font-mono text-[11px] tracking-[0.04em] uppercase">Loading session…</span>
      </div>
    );
  }

  if (isError || !session) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return (
      <div className="flex flex-col items-center gap-2 px-8 py-12 text-center text-[var(--color-text-body-secondary)]">
        <p className="font-mono text-[11px] tracking-[0.04em] uppercase text-[var(--color-status-error-fg)]">
          Failed to load session
        </p>
        <p className="text-[12.5px] font-light">{msg}</p>
      </div>
    );
  }

  const transcript: TranscriptTurn[] = Array.isArray(session.transcript) ? session.transcript : [];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Session key header */}
      <div className="flex items-center gap-[8px] px-[18px] py-[12px] border-b border-cloud-light bg-[var(--color-bg-container)] shrink-0">
        <Mic2 size={13} strokeWidth={1.5} className="text-[var(--color-book-cloth)] shrink-0" />
        <span className="font-mono text-[11px] tracking-[0.04em] text-[var(--color-text-body-secondary)] truncate">
          {session.session_key}
        </span>
        {isActive && (
          <span className="ml-auto flex items-center gap-[5px] font-mono text-[10px] tracking-[0.05em] uppercase text-[var(--color-status-success-fg)] shrink-0">
            <span className="relative flex h-[7px] w-[7px]">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-status-success-fg)] opacity-75" />
              <span className="relative inline-flex rounded-full h-[7px] w-[7px] bg-[var(--color-status-success-fg)]" />
            </span>
            Live
          </span>
        )}
      </div>

      {/* Metadata strip */}
      <MetaBlock session={session} />

      {/* Summary */}
      {session.summary && <SummaryBlock summary={session.summary} />}

      {/* Transcript */}
      {transcript.length > 0 ? (
        <div>
          <div className="px-[18px] py-[10px] border-b border-cloud-light bg-[var(--color-bg-container)]">
            <span className="font-mono text-[10.5px] tracking-[0.05em] uppercase text-[var(--color-text-body-secondary)]">
              Transcript ({transcript.length} turns)
            </span>
          </div>
          {transcript.map((turn, i) => (
            <TurnRow key={i} turn={turn} index={i} />
          ))}
        </div>
      ) : (
        <div className="px-[18px] py-8 text-center">
          <p className="text-[13px] text-[var(--color-text-body-secondary)] font-light">
            {isActive ? 'Transcript will appear as the session progresses.' : 'No transcript recorded.'}
          </p>
        </div>
      )}

      {/* Linked captures */}
      {session.captures_created && session.captures_created.length > 0 && (
        <LinkedCaptures captureIds={session.captures_created} />
      )}
    </div>
  );
}
