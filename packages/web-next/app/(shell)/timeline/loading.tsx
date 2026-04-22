/**
 * Timeline loading skeleton — M3 item 4.5.
 * Mirrors TimelinePage layout:
 *   PageHeader → TimelineFilters bar → count header → 3 date groups × 4 entries each
 */
export default function TimelineLoading() {
  return (
    <div className="animate-pulse space-y-4">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-36 rounded bg-cloud-light" />
        <div className="space-y-2">
          <div className="h-7 w-28 rounded bg-cloud-light" />
          <div className="h-4 w-72 rounded bg-cloud-light" />
        </div>
      </div>

      {/* Filters bar */}
      <div className="flex items-center justify-between border-b border-cloud-light pb-1">
        {/* View tabs */}
        <div className="flex gap-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-7 w-16 border-b-2 border-b-transparent px-3 py-[5px]">
              <div className="h-3 w-full rounded bg-cloud-light" />
            </div>
          ))}
        </div>
        {/* Source dropdown */}
        <div className="h-7 w-28 rounded bg-cloud-light" />
      </div>

      {/* Feed skeleton */}
      <div className="border border-cloud-light rounded-none overflow-hidden">
        {/* Count header */}
        <div className="px-4 py-[8px] border-b border-cloud-light">
          <div className="h-3 w-24 rounded bg-cloud-light" />
        </div>

        {/* 3 date groups */}
        {Array.from({ length: 3 }).map((_, groupIdx) => (
          <div key={groupIdx}>
            {/* Date header */}
            <div className="px-4 py-[6px] border-y border-cloud-light bg-ivory-dark flex items-center gap-3">
              <div className="h-3 w-16 rounded bg-cloud-light" />
              <div className="h-4 w-8 rounded-badge bg-cloud-light" />
            </div>

            {/* 4 entry rows per group */}
            {Array.from({ length: 4 }).map((_, rowIdx) => (
              <div
                key={rowIdx}
                className="flex items-start gap-3 px-4 py-[10px] border-b border-cloud-light last:border-b-0"
              >
                {/* Source icon circle */}
                <div className="flex-shrink-0 w-[28px] h-[28px] rounded-full bg-cloud-light" />

                {/* Text content */}
                <div className="flex-1 space-y-2 min-w-0">
                  {/* Meta row */}
                  <div className="flex items-center gap-[6px]">
                    <div className="w-[7px] h-[7px] rounded-full bg-cloud-light flex-shrink-0" />
                    <div className="h-2.5 w-12 rounded bg-cloud-light" />
                    <div className="h-2.5 w-14 rounded-badge bg-cloud-light" />
                  </div>
                  {/* Preview text */}
                  <div className="space-y-1.5">
                    <div className="h-3 w-full rounded bg-cloud-light" />
                    <div
                      className="h-3 rounded bg-cloud-light"
                      style={{ width: `${60 + (rowIdx * 10) % 30}%` }}
                    />
                  </div>
                </div>

                {/* Timestamp */}
                <div className="flex-shrink-0 h-3 w-12 rounded bg-cloud-light mt-[3px]" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
