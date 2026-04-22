/**
 * Search page loading skeleton.
 * Mirrors page layout: PageHeader → SearchInput → results grid.
 */
export default function SearchLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-40 rounded bg-cloud-light" />
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <div className="h-7 w-24 rounded bg-cloud-light" />
            <div className="h-4 w-72 rounded bg-cloud-light" />
          </div>
        </div>
      </div>

      {/* SearchInput */}
      <div className="h-10 rounded bg-cloud-light" />

      {/* Results placeholder */}
      <div className="flex gap-5 items-start">
        <div className="flex-1 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="rounded-container border border-cloud-light bg-bg-container p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="h-4 w-48 rounded bg-cloud-light" />
                <div className="h-5 w-12 rounded-badge bg-cloud-light" />
              </div>
              <div className="h-3 w-full rounded bg-cloud-light" />
              <div className="h-3 w-[80%] rounded bg-cloud-light" />
            </div>
          ))}
        </div>

        {/* Sidebar skeleton */}
        <div className="hidden lg:block w-52 shrink-0 space-y-2">
          <div className="h-4 w-24 rounded bg-cloud-light" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 rounded bg-cloud-light" />
          ))}
        </div>
      </div>
    </div>
  );
}
