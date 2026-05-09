'use client';

/**
 * EntityFacets — sidebar panel showing entity names mentioned in search results.
 *
 * Client-side grouping: reads the search results cache via TanStack Query
 * (same query key as SearchResults — no extra network request). Extracts
 * entity names from result.capture.entities[], counts mentions, sorts
 * descending. Click on an entity name appends the name to the current
 * search query via router.push.
 *
 * Renders only when there are results with entities.
 */

import { useRouter } from 'next/navigation';
import { useSearch } from '@/lib/api/search.hooks';
import { Eyebrow } from '@/components/design-system/Eyebrow';

interface EntityFacetsProps {
  query: string;
}

interface EntityCount {
  name: string;
  count: number;
}

/** Extract + count entity names from search results. */
function extractEntityCounts(results: Array<{ capture: { entities?: string[] } }>): EntityCount[] {
  const counts = new Map<string, number>();

  for (const result of results) {
    for (const name of result.capture.entities ?? []) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12); // cap at 12 facets
}

export function EntityFacets({ query }: EntityFacetsProps) {
  const router = useRouter();

  // Re-use the same query key as SearchResults — no duplicate fetch
  const { data } = useSearch({ q: query, hybrid: true, limit: 20 });

  const results = data?.results ?? [];
  const facets = extractEntityCounts(results);

  if (facets.length === 0) return null;

  function handleFacetClick(entityName: string) {
    const combined = `${query} ${entityName}`.trim();
    const params = new URLSearchParams({ q: combined });
    router.push(`/search?${params.toString()}`);
  }

  return (
    <div className="rounded-container border border-cloud-light bg-bg-container p-4 space-y-3">
      <Eyebrow noMargin>Entities</Eyebrow>

      <div className="space-y-1">
        {facets.map(({ name, count }) => (
          <button
            key={name}
            type="button"
            onClick={() => handleFacetClick(name)}
            className={[
              'w-full flex items-center justify-between gap-2',
              'px-2 py-[5px] text-left',
              'font-body text-[12.5px] font-light text-text-body',
              'hover:bg-ivory-dark transition-colors duration-[100ms]',
              'rounded-none',
            ].join(' ')}
          >
            <span className="truncate">{name}</span>
            <span className="font-mono text-[10.5px] tracking-[0.04em] text-text-body-secondary shrink-0">
              {count}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
