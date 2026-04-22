/**
 * Investments page loading skeleton.
 * Mirrors InvestmentsPage layout: PageHeader → 2-col charts → full-width chart → holdings table.
 */
export default function InvestmentsLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-44 rounded bg-cloud-light" />
        <div className="space-y-2">
          <div className="h-7 w-32 rounded bg-cloud-light" />
          <div className="h-4 w-96 rounded bg-cloud-light" />
        </div>
      </div>

      {/* Account filter bar */}
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-7 w-24 bg-cloud-light rounded" />
        ))}
      </div>

      {/* 2-column charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[18px]">
        <div className="bg-bg-container border border-cloud-light p-[18px] space-y-3">
          <div className="h-4 w-24 rounded bg-cloud-light" />
          <div className="h-[160px] rounded bg-cloud-light" />
        </div>
        <div className="bg-bg-container border border-cloud-light p-[18px] space-y-3">
          <div className="h-4 w-28 rounded bg-cloud-light" />
          <div className="h-[160px] rounded bg-cloud-light" />
        </div>
      </div>

      {/* Balance history chart */}
      <div className="bg-bg-container border border-cloud-light p-[18px] space-y-3">
        <div className="h-4 w-32 rounded bg-cloud-light" />
        <div className="h-[180px] rounded bg-cloud-light" />
      </div>

      {/* Holdings table */}
      <div className="bg-bg-container border border-cloud-light">
        <div className="px-[18px] py-[12px] border-b border-cloud-light">
          <div className="h-4 w-24 rounded bg-cloud-light" />
        </div>
        <div className="p-[18px] space-y-3">
          {/* Column headers */}
          <div className="flex gap-4 border-b border-cloud-light pb-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-3 w-16 rounded bg-cloud-light" />
            ))}
          </div>
          {/* Rows */}
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-4 items-center">
              <div className="space-y-1 w-32">
                <div className="h-3 w-16 rounded bg-cloud-light" />
                <div className="h-2 w-28 rounded bg-cloud-light" />
              </div>
              {Array.from({ length: 6 }).map((_, j) => (
                <div key={j} className="h-3 w-16 rounded bg-cloud-light" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
