export const dynamic = 'force-dynamic';

/**
 * Search page — Cloudscape screen (Phase 4, items 4.3 + 4.4).
 *
 * RSC shell: renders PageHeader + SearchInput + results area.
 * URL `?q=` drives all search state — browser history works naturally.
 *
 * Layout:
 *   PageHeader
 *   SearchInput  (client — debounced, router.push)
 *   [SynthesisAnswer]  (client — conditional on isSynthesisRequest(q))
 *   [SearchResults + EntityFacets sidebar]  (client — TanStack Query)
 */

import { PageHeader } from '@/components/design-system';
import { SearchInput } from '@/components/search/SearchInput';
import { SearchResults } from '@/components/search/SearchResults';
import { SynthesisAnswer } from '@/components/search/SynthesisAnswer';
import { EntityFacets } from '@/components/search/EntityFacets';

interface SearchPageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q = '' } = await searchParams;
  const query = q.trim();

  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Search']}
        title="Search"
        subtitle="Hybrid semantic + full-text search across all captures"
      />

      {/* Client input: debounced, updates ?q= in URL */}
      <SearchInput initialQuery={query} />

      {query ? (
        <div className="mt-4 flex gap-5 items-start">
          {/* Main column: synthesis answer (conditional) + results */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Synthesis answer card — only shown for question-like queries */}
            <SynthesisAnswer query={query} />

            {/* Result cards with score badges */}
            <SearchResults query={query} />
          </div>

          {/* Sidebar: entity facets derived from results */}
          <aside className="hidden lg:block w-52 shrink-0">
            <EntityFacets query={query} />
          </aside>
        </div>
      ) : (
        /* Empty state — no query entered yet */
        <div className="mt-8 flex flex-col items-center py-16 text-center text-text-body-secondary border border-dashed border-cloud-light rounded-container">
          <div className="w-10 h-10 flex items-center justify-center border border-cloud-light mb-4">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-cloud-dark"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </div>
          <p className="font-display text-[18px] font-normal tracking-[-0.01em] text-text-heading">
            Search your brain
          </p>
          <p className="text-[13px] mt-2 max-w-[360px] leading-relaxed font-light">
            Type a keyword or ask a question. Semantic and full-text search
            combined — results ranked by relevance and recency.
          </p>
        </div>
      )}
    </>
  );
}
