/**
 * Dashboard loading skeleton — Screen 01.
 * Mirrors DashboardPage layout:
 *   PageHeader → StatStrip (5 stat blocks) → 2-col grid
 *   Left col:  QuickCapture (~120px) + RecentCaptures (8 rows ~48px each)
 *   Right col: OpenQuestions (4 rows) + UpcomingBriefs (3 rows)
 */
export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-40 rounded bg-cloud-light" />
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <div className="h-7 w-56 rounded bg-cloud-light" />
            <div className="h-4 w-80 rounded bg-cloud-light" />
          </div>
          {/* action buttons */}
          <div className="flex gap-2">
            <div className="h-7 w-20 rounded bg-cloud-light" />
            <div className="h-7 w-20 rounded bg-cloud-light" />
            <div className="h-7 w-24 rounded bg-cloud-light" />
          </div>
        </div>
      </div>

      {/* StatStrip — 5 equal-width stat blocks */}
      <div className="grid grid-cols-5 gap-px bg-cloud-light border border-cloud-light">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-bg-container p-4 space-y-2">
            <div className="h-3 w-16 rounded bg-cloud-light" />
            <div className="h-8 w-12 rounded bg-cloud-light" />
            <div className="h-3 w-20 rounded bg-cloud-light" />
          </div>
        ))}
      </div>

      {/* 2-col grid */}
      <div
        className="grid gap-5"
        style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)' }}
      >
        {/* Left column */}
        <div className="flex flex-col gap-5">
          {/* QuickCapture container */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-32 rounded bg-cloud-light" />
            <div className="h-3 w-64 rounded bg-cloud-light" />
            {/* textarea placeholder */}
            <div className="h-20 rounded bg-cloud-light" />
            {/* toolbar row */}
            <div className="flex gap-2 justify-between">
              <div className="flex gap-2">
                <div className="h-6 w-16 rounded bg-cloud-light" />
                <div className="h-6 w-16 rounded bg-cloud-light" />
              </div>
              <div className="h-7 w-24 rounded bg-cloud-light" />
            </div>
          </div>

          {/* RecentCaptures container — 8 row stubs */}
          <div className="bg-bg-container border border-cloud-light rounded-container">
            <div className="px-4 py-3 border-b border-cloud-light flex items-center justify-between">
              <div className="h-4 w-36 rounded bg-cloud-light" />
              <div className="flex gap-2">
                <div className="h-6 w-14 rounded bg-cloud-light" />
                <div className="h-6 w-16 rounded bg-cloud-light" />
              </div>
            </div>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="px-4 py-3 flex items-start gap-3 border-b border-cloud-light last:border-b-0"
              >
                <div className="mt-0.5 h-5 w-5 rounded-full bg-cloud-light flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-full max-w-[340px] rounded bg-cloud-light" />
                  <div className="h-3 w-24 rounded bg-cloud-light" />
                </div>
                <div className="h-5 w-14 rounded bg-cloud-light flex-shrink-0" />
              </div>
            ))}
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-5">
          {/* OpenQuestions container — 4 rows */}
          <div className="bg-bg-container border border-cloud-light rounded-container">
            <div className="px-4 py-3 border-b border-cloud-light flex items-center justify-between">
              <div className="h-4 w-32 rounded bg-cloud-light" />
              <div className="h-6 w-14 rounded bg-cloud-light" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="px-4 py-3 space-y-1.5 border-b border-cloud-light last:border-b-0"
              >
                <div className="h-3.5 w-full rounded bg-cloud-light" />
                <div className="h-3 w-20 rounded bg-cloud-light" />
              </div>
            ))}
          </div>

          {/* UpcomingBriefs container — 3 rows */}
          <div className="bg-bg-container border border-cloud-light rounded-container">
            <div className="px-4 py-3 border-b border-cloud-light flex items-center justify-between">
              <div className="h-4 w-32 rounded bg-cloud-light" />
              <div className="h-6 w-16 rounded bg-cloud-light" />
            </div>
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="px-4 py-3 flex items-center gap-3 border-b border-cloud-light last:border-b-0"
              >
                <div className="h-8 w-8 rounded bg-cloud-light flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 rounded bg-cloud-light" />
                  <div className="h-3 w-24 rounded bg-cloud-light" />
                </div>
                <div className="h-5 w-16 rounded bg-cloud-light flex-shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
