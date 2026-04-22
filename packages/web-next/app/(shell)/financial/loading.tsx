/**
 * Financial page loading skeleton.
 * Mirrors FinancialPage layout: PageHeader → tab bar → capture list.
 */
export default function FinancialLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-40 rounded bg-cloud-light" />
        <div className="space-y-2">
          <div className="h-7 w-28 rounded bg-cloud-light" />
          <div className="h-4 w-80 rounded bg-cloud-light" />
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-cloud-light gap-0">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-9 w-20 bg-cloud-light mr-1 rounded-t" />
        ))}
      </div>

      {/* Capture card list */}
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="bg-bg-container border border-cloud-light p-4 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="h-3 w-32 rounded bg-cloud-light" />
              <div className="h-4 w-16 rounded-badge bg-cloud-light" />
            </div>
            <div className="space-y-1">
              <div className="h-3 w-full rounded bg-cloud-light" />
              <div className="h-3 w-[75%] rounded bg-cloud-light" />
            </div>
            <div className="h-3 w-20 rounded bg-cloud-light" />
          </div>
        ))}
      </div>
    </div>
  );
}
