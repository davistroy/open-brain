export const dynamic = 'force-dynamic';

/**
 * Wiki root page — /wiki
 *
 * Lists all wiki pages in the sidebar nav tree and shows aggregate
 * stats + a welcome/index message in the main content area.
 *
 * RSC: fetches page list, recent changes, lint report, and stats in
 * parallel. Passes them down to the client components WikiNavTree
 * (sidebar) and WikiTabs (main content area).
 */

import { Book, RefreshCw } from 'lucide-react';
import { PageHeader, Button } from '@/components/design-system';
import { WikiNavTree } from '@/components/wiki/WikiNavTree';
import { WikiTabs } from '@/components/wiki/WikiTabs';
import { wikiApi } from '@/lib/api-client';
import type { WikiPageMeta, WikiChange, WikiLintReport, WikiStats } from '@/lib/api-client';

const EMPTY_LINT: WikiLintReport = { total_pages: 0, issues: [], last_run: null };
const EMPTY_STATS: WikiStats = { total_pages: 0, by_type: {}, orphaned_pages: 0, domains: [] };

export default async function WikiPage() {
  const [pagesResult, changesResult, lintResult, statsResult] = await Promise.allSettled([
    wikiApi.pages(),
    wikiApi.recentChanges(20),
    wikiApi.lintReport(),
    wikiApi.stats(),
  ]);

  const pages: WikiPageMeta[] =
    pagesResult.status === 'fulfilled' ? pagesResult.value.pages : [];

  const changes: WikiChange[] =
    changesResult.status === 'fulfilled' ? changesResult.value.changes : [];

  const lintReport: WikiLintReport =
    lintResult.status === 'fulfilled' ? lintResult.value : EMPTY_LINT;

  const stats: WikiStats =
    statsResult.status === 'fulfilled' ? statsResult.value : EMPTY_STATS;

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Wiki']}
        title="Wiki"
        subtitle={`${stats.total_pages} pages across ${stats.domains?.length ?? 0} domain${stats.domains?.length !== 1 ? 's' : ''}`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={12} strokeWidth={1.5} />}
          >
            Refresh
          </Button>
        }
      />

      {/* 2-col layout: sidebar nav | main content */}
      <div
        className="grid gap-[20px]"
        style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}
      >
        {/* Sidebar nav tree */}
        <aside>
          <div className="sticky top-[20px]">
            <div className="text-[10.5px] font-mono text-text-body-secondary tracking-[0.06em] uppercase mb-[8px] px-[8px]">
              Pages
            </div>
            <WikiNavTree pages={pages} activeSlug={null} />
          </div>
        </aside>

        {/* Main content with tabs */}
        <main className="min-w-0">
          {pages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-[64px] text-center">
              <Book size={32} strokeWidth={1} className="text-text-body-secondary mb-[12px] opacity-40" />
              <div className="text-[16px] text-text-body-secondary font-light mb-[6px]">
                No wiki pages yet
              </div>
              <div className="text-[13px] text-text-body-secondary font-light max-w-[340px]">
                Create a capture — when it reaches the wiki synthesis threshold, a page will be generated automatically.
              </div>
            </div>
          ) : (
            <WikiTabs
              page={null}
              changes={changes}
              lintReport={lintReport}
              stats={stats}
              activePath={null}
            />
          )}
        </main>
      </div>
    </>
  );
}
