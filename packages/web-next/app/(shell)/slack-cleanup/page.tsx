export const dynamic = 'force-dynamic';

/**
 * SlackCleanup page — Cloudscape M3, work item 6.5.
 *
 * RSC: server-fetches Slack channel data via GET /api/v1/admin/slack/channels.
 * Passes initial channel list to ChannelTable client component which owns:
 *   - Inactivity threshold filter state
 *   - Sort state
 *   - Archive mutation + confirmation modal
 *   - Summary cards (updates on filter change)
 *
 * Route: /slack-cleanup
 */

import { Suspense } from 'react';
import { Hash } from 'lucide-react';
import { PageHeader } from '@/components/design-system';
import { ChannelTable } from '@/components/slack/ChannelTable';
import { adminApi, type SlackChannel } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Server-side fetch
// ---------------------------------------------------------------------------

async function fetchSlackChannels(): Promise<SlackChannel[]> {
  try {
    const result = await adminApi.getSlackChannels();
    return result.channels;
  } catch (err) {
    console.error('[SlackCleanupPage] channel fetch failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SlackCleanupPage() {
  const channels = await fetchSlackChannels();

  const activeCount = channels.filter((ch) => !ch.is_archived).length;
  const archivedCount = channels.filter((ch) => ch.is_archived).length;

  const subtitle =
    channels.length === 0
      ? 'No Slack channels found — check that SLACK_BOT_TOKEN or SLACK_USER_TOKEN is set'
      : [
          `${activeCount} active channel${activeCount !== 1 ? 's' : ''}`,
          archivedCount > 0 ? `${archivedCount} already archived` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Slack Cleanup']}
        title="Slack Cleanup"
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
            <Hash size={11} strokeWidth={1.5} />
            <span>Channel hygiene</span>
          </div>
        }
      />

      <Suspense
        fallback={
          <div className="flex h-[400px] border border-cloud-light bg-bg-container items-center justify-center text-[var(--color-text-body-secondary)] font-mono text-[11px] tracking-[0.04em] uppercase">
            Loading channels…
          </div>
        }
      >
        <ChannelTable initialChannels={channels} />
      </Suspense>
    </>
  );
}
