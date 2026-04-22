/**
 * Board loading skeleton — Cloudscape screen 09.
 * Mirrors BoardPage layout: PageHeader → GroupByBar → 4-column Kanban grid.
 * Each column shows: colored top-border header + 3 placeholder cards.
 */
export default function BoardLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-40 rounded bg-cloud-light" />
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <div className="h-7 w-20 rounded bg-cloud-light" />
            <div className="h-4 w-72 rounded bg-cloud-light" />
          </div>
        </div>
      </div>

      {/* GroupByBar + New Item button row */}
      <div className="flex items-center justify-between">
        <div className="flex gap-0 border border-cloud-light overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 w-20 bg-cloud-light border-r border-cloud-light last:border-r-0" />
          ))}
        </div>
        <div className="h-7 w-28 rounded bg-cloud-light" />
      </div>

      {/* 4-column Kanban grid */}
      <div className="grid grid-cols-4 gap-4 items-start">
        {Array.from({ length: 4 }).map((_, colIdx) => (
          <div key={colIdx} className="space-y-2">
            {/* Column header with colored top border */}
            <div className="border-t-4 border border-cloud-light bg-bg-container px-3 py-[10px] flex items-center justify-between">
              <div className="h-3 w-20 rounded bg-cloud-light" />
              <div className="h-4 w-6 rounded-badge bg-cloud-light" />
            </div>

            {/* 3 placeholder cards */}
            {Array.from({ length: 3 }).map((_, cardIdx) => (
              <div
                key={cardIdx}
                className="bg-bg-container border border-l-4 border-cloud-light rounded-none p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="h-2.5 w-16 rounded bg-cloud-light" />
                  <div className="h-4 w-14 rounded-badge bg-cloud-light" />
                </div>
                <div className="space-y-1">
                  <div className="h-3 w-full rounded bg-cloud-light" />
                  <div className="h-3 w-[80%] rounded bg-cloud-light" />
                </div>
                <div className="h-3 w-24 rounded bg-cloud-light" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
