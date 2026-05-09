'use client';

/**
 * VoiceConversationsClient — stateful two-pane orchestrator.
 *
 * Holds `selectedId` state and passes it down to SessionList (left pane)
 * and SessionDetail (right pane). Also polls for active sessions every 10s
 * so the isActive flag propagates correctly to SessionDetail.
 *
 * Rendered by the VoiceConversations RSC page; receives server-prefetched
 * initial session data to avoid a loading flash.
 */

import { useState } from 'react';
import { SessionList } from './SessionList';
import { SessionDetail } from './SessionDetail';
import { useActiveVoiceSessions } from '@/lib/api/voice.hooks';
import type { VoiceSession } from '@/lib/api-client';
import { MicOff } from 'lucide-react';

// ---------------------------------------------------------------------------
// VoiceConversationsClient
// ---------------------------------------------------------------------------

interface VoiceConversationsClientProps {
  initialSessions: VoiceSession[];
  initialTotal: number;
}

export function VoiceConversationsClient({
  initialSessions,
  initialTotal,
}: VoiceConversationsClientProps) {
  // Auto-select the first session on mount if sessions exist
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSessions[0]?.id ?? null,
  );

  // Poll for active sessions to determine the isActive flag for SessionDetail
  const { data: activeData } = useActiveVoiceSessions();

  const activeIds = new Set((activeData?.items ?? []).map((s) => s.id));
  const selectedIsActive = selectedId !== null && activeIds.has(selectedId);

  return (
    <div
      className="flex border border-cloud-light bg-[var(--color-bg-container)]"
      style={{ minHeight: 540 }}
    >
      {/* Left pane — session list */}
      <div className="shrink-0 border-r border-cloud-light overflow-hidden" style={{ width: 300 }}>
        <SessionList
          initialSessions={initialSessions}
          initialTotal={initialTotal}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      {/* Right pane — session detail */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {selectedId !== null ? (
          <SessionDetail sessionId={selectedId} isActive={selectedIsActive} />
        ) : (
          <div className="flex flex-col items-center gap-3 px-8 py-16 text-center text-[var(--color-text-body-secondary)]">
            <MicOff size={24} strokeWidth={1.3} className="text-[var(--color-cloud-dark)]" />
            <p className="text-[13.5px] font-light">
              Select a session to view its transcript and linked captures.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
