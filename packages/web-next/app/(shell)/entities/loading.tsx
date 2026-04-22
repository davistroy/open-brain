/**
 * Entities list loading skeleton — Screen 05.
 * Mirrors EntitiesPage layout:
 *   PageHeader → TypeFilterTabs (6 tabs) → 2-col grid
 *   Left: EntityTable (8 rows)
 *   Right sidebar (280px): DistributionCard + NeedsAttention
 */
export default function EntitiesLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-40 rounded bg-cloud-light" />
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <div className="h-7 w-28 rounded bg-cloud-light" />
            <div className="h-4 w-96 rounded bg-cloud-light" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 w-20 rounded bg-cloud-light" />
            <div className="h-7 w-20 rounded bg-cloud-light" />
            <div className="h-7 w-24 rounded bg-cloud-light" />
          </div>
        </div>
      </div>

      {/* TypeFilterTabs — 6 pill-style tabs */}
      <div className="flex gap-2 border-b border-cloud-light pb-0">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 w-24 rounded-t bg-cloud-light" />
        ))}
      </div>

      {/* 2-col grid */}
      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: '1fr 280px' }}
      >
        {/* EntityTable — 8 rows */}
        <div className="bg-bg-container border border-cloud-light rounded-container">
          {/* Table header row */}
          <div className="px-4 py-3 flex items-center gap-4 border-b border-cloud-light bg-bg-cell-shaded">
            <div className="h-3 w-4 rounded bg-cloud-light" />
            <div className="h-3 w-32 rounded bg-cloud-light" />
            <div className="h-3 w-20 rounded bg-cloud-light ml-auto" />
            <div className="h-3 w-16 rounded bg-cloud-light" />
            <div className="h-3 w-20 rounded bg-cloud-light" />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="px-4 py-3 flex items-center gap-4 border-b border-cloud-light last:border-b-0"
            >
              {/* monogram */}
              <div className="h-8 w-8 rounded-item bg-cloud-light flex-shrink-0" />
              {/* name + type */}
              <div className="flex-1 space-y-1">
                <div className="h-3.5 w-40 rounded bg-cloud-light" />
                <div className="h-3 w-20 rounded bg-cloud-light" />
              </div>
              {/* mention count */}
              <div className="h-5 w-10 rounded bg-cloud-light" />
              {/* last seen */}
              <div className="h-3 w-16 rounded bg-cloud-light" />
              {/* status badge */}
              <div className="h-5 w-16 rounded-badge bg-cloud-light" />
            </div>
          ))}
        </div>

        {/* Right sidebar */}
        <aside className="flex flex-col gap-4">
          {/* DistributionCard */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-28 rounded bg-cloud-light" />
            {/* bar chart stubs */}
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between">
                  <div className="h-3 w-20 rounded bg-cloud-light" />
                  <div className="h-3 w-8 rounded bg-cloud-light" />
                </div>
                <div
                  className="h-2 rounded bg-cloud-light"
                  style={{ width: `${85 - i * 14}%` }}
                />
              </div>
            ))}
          </div>

          {/* NeedsAttention */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-32 rounded bg-cloud-light" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-cloud-light flex-shrink-0" />
                <div className="h-3 w-full rounded bg-cloud-light" />
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
