export const dynamic = 'force-dynamic';

/**
 * Wiki page — /wiki/[...slug]
 *
 * Dynamic catch-all route handling any nested wiki page path.
 * Examples:
 *   /wiki/career           → slug = ['career']
 *   /wiki/career/goals     → slug = ['career', 'goals']
 *   /wiki/some/nested/page → slug = ['some', 'nested', 'page']
 *
 * RSC: fetches the specific page content + sidebar pages + tabs data
 * in parallel. Calls notFound() on 404.
 */

import { notFound } from 'next/navigation';
import { RefreshCw, Zap } from 'lucide-react';
import { PageHeader, Button } from '@/components/design-system';
import { WikiNavTree } from '@/components/wiki/WikiNavTree';
import { WikiTabs } from '@/components/wiki/WikiTabs';
import { wikiApi, HttpError } from '@/lib/api-client';
import type { WikiPageMeta, WikiPageFull, WikiChange, WikiLintReport, WikiStats } from '@/lib/api-client';

const EMPTY_LINT: WikiLintReport = { total_pages: 0, issues: [], last_run: null };
const EMPTY_STATS: WikiStats = { total_pages: 0, by_type: {}, orphaned_pages: 0, domains: [] };

interface WikiSlugPageProps {
  params: Promise<{ slug: string[] }>;
}

export default async function WikiSlugPage({ params }: WikiSlugPageProps) {
  const { slug } = await params;

  // Join slug segments into the page path used by the API, e.g. "career/goals"
  const pagePath = slug.join('/');

  // Fetch the specific page — 404 → notFound(); other errors propagate to error.tsx
  let page: WikiPageFull;
  try {
    page = await wikiApi.page(pagePath);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  // Non-critical parallel fetches — degrade gracefully
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

  // Build breadcrumb: Open Brain / Wiki / <segment> / ... / <page title>
  const breadcrumb = [
    'Open Brain',
    'Wiki',
    ...slug.slice(0, -1).map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1)),
    page.title,
  ];

  return (
    <>
      <PageHeader
        breadcrumb={breadcrumb}
        title={page.title}
        subtitle={`Updated ${new Date(page.updated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}${page.source_count ? ` · ${page.source_count} sources` : ''}`}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={12} strokeWidth={1.5} />}
            >
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Zap size={12} strokeWidth={1.5} />}
            >
              Re-synthesize
            </Button>
          </>
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
            <WikiNavTree pages={pages} activeSlug={pagePath} />
          </div>
        </aside>

        {/* Main content with tabs */}
        <main className="min-w-0">
          <WikiTabs
            page={page}
            changes={changes}
            lintReport={lintReport}
            stats={stats}
            activePath={pagePath}
          />
        </main>
      </div>
    </>
  );
}
