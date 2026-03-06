import { useState, useCallback, useRef, useEffect } from 'react';
import { Search as SearchIcon, X, ChevronLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import CaptureCard from '@/components/CaptureCard';
import CaptureDetail from '@/components/CaptureDetail';
import SearchFiltersPanel from '@/components/SearchFilters';
import { searchApi } from '@/lib/api';
import type { Capture, SearchFilters } from '@/lib/types';

const DEFAULT_FILTERS: SearchFilters = {
  hybrid: true,
  limit: 20,
};

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [results, setResults] = useState<Capture[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [selectedCapture, setSelectedCapture] = useState<Capture | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const debouncedQuery = useDebounce(query, 400);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (q: string, f: SearchFilters) => {
      if (!q.trim()) {
        setResults([]);
        setTotal(0);
        setSearched(false);
        return;
      }

      // Cancel in-flight request
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setError(null);

      try {
        const result = await searchApi.search({ ...f, q: q.trim() });
        setResults(result.captures);
        setTotal(result.total);
        setSearched(true);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Auto-search on debounced query or filter change
  useEffect(() => {
    runSearch(debouncedQuery, filters);
  }, [debouncedQuery, filters, runSearch]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch(query, filters);
  }

  function handleClearFilters() {
    setFilters(DEFAULT_FILTERS);
  }

  const activeFilterCount = [
    filters.brain_view,
    filters.capture_type,
    filters.source,
    filters.start_date,
    filters.end_date,
  ].filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Search</h1>
      </div>

      {/* Search input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search captures semantically..."
            className="pl-9 pr-8"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setResults([]);
                setSearched(false);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setShowFilters((v) => !v)}
          className={`gap-1.5 shrink-0 ${showFilters ? 'bg-accent' : ''}`}
        >
          Filters
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
              {activeFilterCount}
            </span>
          )}
        </Button>
      </form>

      {/* Main layout: filters sidebar + results */}
      <div className="flex gap-4 items-start">
        {/* Filters panel */}
        {showFilters && (
          <div className="w-52 shrink-0">
            <SearchFiltersPanel
              filters={filters}
              onChange={setFilters}
              onClear={handleClearFilters}
            />
          </div>
        )}

        {/* Results area */}
        <div className="flex-1 min-w-0">
          {/* Loading state */}
          {loading && (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-20 rounded-lg bg-secondary animate-pulse" />
              ))}
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Empty state — no query */}
          {!loading && !error && !searched && (
            <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
              <SearchIcon className="h-8 w-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Type to search across all captures.</p>
              <p className="text-xs mt-1">Semantic + full-text hybrid search. Results ranked by relevance.</p>
            </div>
          )}

          {/* No results */}
          {!loading && !error && searched && results.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              <p className="text-sm">No results for &ldquo;{query}&rdquo;</p>
              <p className="text-xs mt-1">Try different terms or remove filters.</p>
            </div>
          )}

          {/* Results */}
          {!loading && results.length > 0 && (
            <div className="space-y-3">
              {/* Results summary */}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {total} result{total !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
                  {activeFilterCount > 0 && ` (${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''})`}
                </span>
                <span>{filters.hybrid !== false ? 'Hybrid (FTS + vector)' : 'Vector only'}</span>
              </div>

              {/* Capture list */}
              <div className="space-y-2">
                {results.map((capture) => (
                  <div
                    key={capture.id}
                    onClick={() => setSelectedCapture(capture)}
                    className="cursor-pointer"
                  >
                    <CaptureCard
                      capture={capture}
                      similarity={capture.similarity}
                      className={selectedCapture?.id === capture.id ? 'border-primary ring-1 ring-primary' : ''}
                    />
                  </div>
                ))}
              </div>

              {/* Load more — if total > shown */}
              {total > results.length && (
                <div className="text-center pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      runSearch(query, { ...filters, limit: (filters.limit ?? 20) + 20 })
                    }
                    disabled={loading}
                  >
                    Load more ({total - results.length} remaining)
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Capture detail panel */}
        {selectedCapture && (
          <div className="hidden lg:flex w-96 shrink-0 flex-col rounded-lg border bg-card min-h-[400px] max-h-[80vh] overflow-y-auto sticky top-4">
            <CaptureDetail
              capture={selectedCapture}
              similarity={selectedCapture.similarity}
              onClose={() => setSelectedCapture(null)}
            />
          </div>
        )}
      </div>

      {/* Mobile: capture detail as overlay */}
      {selectedCapture && (
        <div className="lg:hidden fixed inset-0 z-50 bg-background overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedCapture(null)}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
            <span className="text-sm font-medium">Capture Detail</span>
          </div>
          <div className="p-4">
            <CaptureDetail
              capture={selectedCapture}
              similarity={selectedCapture.similarity}
              onClose={() => setSelectedCapture(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
