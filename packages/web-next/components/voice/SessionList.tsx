'use client';

/**
 * SessionList — left-pane client component for the VoiceConversations page.
 *
 * Renders:
 *   - Active session banner (if any) with CSS ping animation
 *   - Sorted list of session rows; click to select
 *
 * Polling: active sessions are re-fetched every 10 seconds via
 * TanStack Query's `refetchInterval`. The full session list is
 * fetched once without polling (append-only, sessions don't change
 * after they complete).
 *
 * Props:
 *   initialSessions  — pre-fetched server-side session list
 *   selectedId       — currently selected session ID (controlled)
 *   onSelect         — callback when a session row is clicked
 */

import { Mic, MicOff, Radio } from 'lucide-react';
import { useClientNow } from '@/hooks/useClientNow';
import { useVoiceSessions, useActiveVoiceSessions } from '@/lib/api/voice.hooks';
import type { VoiceSession } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a session started_at into a compact human-readable string. */
function formatDate(isoString: string, now: number | null): string {
  const d = new Date(isoString);
  // Pre-mount (SSR + first client render): stable absolute date, no `now` dependency.
  if (now === null) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const diffMs = now - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return d.toLocaleDateString('en-US', { weekday: 'short' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format duration_seconds as "Xm Ys" or "Xm". */
function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Derive a display title for a session. */
function sessionTitle(session: VoiceSession): string {
  if (session.summary) {
    // Trim summary to first sentence or 60 chars
    const firstSentence = session.summary.split(/[.!?]/)[0]?.trim() ?? '';
    return firstSentence.length > 0
      ? firstSentence.slice(0, 60) + (firstSentence.length > 60 ? '…' : '')
      : session.session_key;
  }
  return session.session_key;
}

// ---------------------------------------------------------------------------
// SessionRow
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: VoiceSession;
  isActive: boolean;
  isSelected: boolean;
  onClick: () => void;
}

function SessionRow({ session, isActive, isSelected, onClick }: SessionRowProps) {
  const now = useClientNow();
  const title = sessionTitle(session);
  const date = formatDate(session.started_at, now);
  const duration = formatDuration(session.duration_seconds);
  const turns = session.turn_count ?? 0;
  const captureCount = session.captures_created?.length ?? 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full text-left px-4 py-[10px] border-b border-cloud-light',
        'transition-colors duration-75',
        isSelected
          ? 'bg-[var(--color-book-cloth)] text-white'
          : 'hover:bg-[var(--color-bg-container)] text-[var(--color-text-body)]',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Row header: title + date */}
      <div className="flex items-start justify-between gap-2 mb-[3px]">
        <span
          className={[
            'font-display text-[13.5px] font-normal tracking-[-0.005em] leading-[1.3] min-w-0 truncate',
            isSelected ? 'text-white' : 'text-[var(--color-text-heading)]',
          ].join(' ')}
        >
          {title}
        </span>
        <span
          className={[
            'font-mono text-[10px] tracking-[0.04em] uppercase shrink-0 mt-[1px]',
            isSelected ? 'text-white/70' : 'text-[var(--color-text-body-secondary)]',
          ].join(' ')}
        >
          {date}
        </span>
      </div>

      {/* Row meta: duration + turns + captures */}
      <div
        className={[
          'flex items-center gap-[10px] font-mono text-[10.5px] tracking-[0.04em] uppercase',
          isSelected ? 'text-white/60' : 'text-[var(--color-text-body-secondary)]',
        ].join(' ')}
      >
        {isActive && (
          <span className="flex items-center gap-[5px]">
            <Radio size={9} strokeWidth={1.5} />
            <span>Live</span>
          </span>
        )}
        {duration && <span>{duration}</span>}
        {turns > 0 && <span>{turns} turns</span>}
        {captureCount > 0 && <span>{captureCount} capture{captureCount !== 1 ? 's' : ''}</span>}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ActiveBanner
// ---------------------------------------------------------------------------

interface ActiveBannerProps {
  sessions: VoiceSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function ActiveBanner({ sessions, selectedId, onSelect }: ActiveBannerProps) {
  if (sessions.length === 0) return null;

  const first = sessions[0]!;

  return (
    <button
      type="button"
      onClick={() => onSelect(first.id)}
      className={[
        'w-full text-left px-4 py-[10px] border-b border-cloud-light',
        'bg-[var(--color-status-success-bg)] transition-colors duration-75',
        selectedId === first.id ? 'ring-1 ring-inset ring-[var(--color-book-cloth)]' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-[8px]">
        {/* Ping animation dot */}
        <span className="relative flex h-[8px] w-[8px] shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-status-success-fg)] opacity-75" />
          <span className="relative inline-flex rounded-full h-[8px] w-[8px] bg-[var(--color-status-success-fg)]" />
        </span>
        <span className="font-mono text-[10.5px] tracking-[0.05em] uppercase text-[var(--color-status-success-fg)]">
          Live session
        </span>
      </div>
      <div className="mt-[3px] font-display text-[12.5px] font-normal text-[var(--color-text-heading)] truncate">
        {sessionTitle(first)}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SessionList
// ---------------------------------------------------------------------------

interface SessionListProps {
  initialSessions: VoiceSession[];
  initialTotal: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SessionList({
  initialSessions,
  initialTotal,
  selectedId,
  onSelect,
}: SessionListProps) {
  // Full session list — no polling needed; sessions only added, never mutated in-place
  const { data: sessionsData } = useVoiceSessions(
    { limit: 100 },
    { initialData: { items: initialSessions, total: initialTotal, limit: 100, offset: 0 } },
  );

  // Active sessions — polled every 10 seconds (shared key with VoiceConversationsClient)
  const { data: activeData } = useActiveVoiceSessions();

  const sessions = sessionsData?.items ?? initialSessions;
  const activeSessions = activeData?.items ?? [];
  const activeIds = new Set(activeSessions.map((s) => s.id));

  // Merge active sessions on top if not already in the main list
  const activeNotInList = activeSessions.filter((a) => !sessions.some((s) => s.id === a.id));
  const allSessions = [...activeNotInList, ...sessions];

  return (
    <div className="flex flex-col h-full border-r border-cloud-light min-w-0">
      {/* Header */}
      <div className="px-4 py-[10px] border-b border-cloud-light bg-[var(--color-bg-container)] flex items-center justify-between shrink-0">
        <span className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-[var(--color-text-body-secondary)]">
          {(sessionsData?.total ?? initialTotal).toLocaleString()} sessions
        </span>
        <Mic size={11} strokeWidth={1.5} className="text-[var(--color-text-body-secondary)]" />
      </div>

      {/* Active session banner */}
      {activeSessions.length > 0 && (
        <div className="shrink-0">
          <ActiveBanner sessions={activeSessions} selectedId={selectedId} onSelect={onSelect} />
        </div>
      )}

      {/* Session list */}
      <div className="overflow-y-auto flex-1">
        {allSessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <MicOff size={20} strokeWidth={1.3} className="text-[var(--color-cloud-dark)]" />
            <p className="text-[13px] text-[var(--color-text-body-secondary)] font-light">
              No voice sessions yet.
            </p>
          </div>
        ) : (
          allSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={activeIds.has(session.id)}
              isSelected={selectedId === session.id}
              onClick={() => onSelect(session.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
