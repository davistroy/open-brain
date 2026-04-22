export const dynamic = 'force-dynamic';

/**
 * Email page — Cloudscape M3, work item 6.3.
 *
 * RSC: fetches initial email captures and draft data server-side.
 * Passes to EmailTabs client component which owns tab state + mutations.
 *
 * Layout: 3-tab surface
 *   Inbound  — captures with source='email' (inbound received emails)
 *   Drafts   — outbound email drafts (send / reject actions)
 *   Threads  — client-side thread reconstruction by normalized subject
 *
 * Route: /email
 */

import { Suspense } from 'react';
import { PageHeader } from '@/components/design-system';
import { EmailTabs } from '@/components/email/EmailTabs';
import { capturesApi, emailApi } from '@/lib/api-client';
import type { Capture } from '@/lib/types';
import type { EmailDraft } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Server-side data fetch
// ---------------------------------------------------------------------------

async function fetchEmailCaptures(): Promise<Capture[]> {
  try {
    const result = await capturesApi.list({ source: 'email', limit: 100 });
    return result.items;
  } catch (err) {
    console.error('[EmailPage] email captures fetch failed:', err);
    return [];
  }
}

async function fetchEmailDrafts(): Promise<EmailDraft[]> {
  try {
    // Fetch pending drafts (draft status only) for the Drafts tab.
    // Sent/rejected are available but not the primary UI focus.
    const result = await emailApi.list({ limit: 50 });
    return result.items;
  } catch (err) {
    console.error('[EmailPage] email drafts fetch failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function EmailPage() {
  const [captures, drafts] = await Promise.all([
    fetchEmailCaptures(),
    fetchEmailDrafts(),
  ]);

  const pendingDraftCount = drafts.filter((d) => d.status === 'draft').length;
  const subtitle = [
    `${captures.length} inbound capture${captures.length !== 1 ? 's' : ''}`,
    pendingDraftCount > 0
      ? `${pendingDraftCount} draft${pendingDraftCount !== 1 ? 's' : ''} awaiting review`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Email']}
        title="Email Bridge"
        subtitle={subtitle || 'No email activity yet'}
      />

      <Suspense
        fallback={
          <div className="flex h-[400px] border border-cloud-light bg-bg-container items-center justify-center text-[var(--color-text-body-secondary)] font-mono text-[11px] tracking-[0.04em] uppercase">
            Loading email data…
          </div>
        }
      >
        <EmailTabs
          initialCaptures={captures}
          initialDrafts={drafts}
        />
      </Suspense>
    </>
  );
}
