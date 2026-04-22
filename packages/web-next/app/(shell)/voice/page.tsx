export const dynamic = 'force-dynamic';

/**
 * VoiceConversations page — Cloudscape screen (M3, item 5.5).
 *
 * RSC: fetches the first page of voice sessions (50 items) server-side
 * and passes initial data to the client components. This avoids a loading
 * flash on first render.
 *
 * Layout: two-pane split
 *   Left pane  (320px, fixed)  — SessionList: session rows + active banner
 *   Right pane (flex-1)        — SessionDetail: transcript + linked captures
 *
 * The active session detection (polling every 10s) runs client-side in
 * SessionList via TanStack Query's refetchInterval.
 *
 * Route: /voice
 */

import { Suspense } from 'react';
import { PageHeader } from '@/components/design-system';
import { VoiceConversationsClient } from '@/components/voice/VoiceConversationsClient';
import { voiceSessionApi } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Server-side data fetch
// ---------------------------------------------------------------------------

async function fetchInitialSessions() {
  try {
    return await voiceSessionApi.list({ limit: 50 });
  } catch (err) {
    console.error('[VoicePage] initial fetch failed:', err);
    return { items: [], total: 0, limit: 50, offset: 0 };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function VoiceConversationsPage() {
  const initialData = await fetchInitialSessions();

  const subtitle =
    initialData.total > 0
      ? `${initialData.total.toLocaleString()} session${initialData.total !== 1 ? 's' : ''} — select one to view transcript and linked captures`
      : 'No voice sessions yet — start a conversation to see it here';

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Voice']}
        title="Voice Conversations"
        subtitle={subtitle}
      />

      {/* Two-pane layout: fixed-width left list + flex right detail */}
      <Suspense
        fallback={
          <div className="flex h-[540px] border border-cloud-light bg-bg-container items-center justify-center text-[var(--color-text-body-secondary)] font-mono text-[11px] tracking-[0.04em] uppercase">
            Loading sessions…
          </div>
        }
      >
        <VoiceConversationsClient
          initialSessions={initialData.items}
          initialTotal={initialData.total}
        />
      </Suspense>
    </>
  );
}
