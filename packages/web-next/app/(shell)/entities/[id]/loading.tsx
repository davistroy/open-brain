/**
 * Entity detail loading skeleton — Screen 06.
 * Mirrors EntityDetailPage layout:
 *   PageHeader (breadcrumb only) → EntityHeader (hero monogram + 5-stat row)
 *   → EntityTabs → 2-col grid (main | 320px sidebar)
 *   Main: AISummary + CommitmentsCard + CaptureItems
 *   Sidebar: RelationshipGraph + MentionsChart + RelatedEntities
 */
export default function EntityDetailLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader — breadcrumb only */}
      <div className="h-3 w-48 rounded bg-cloud-light" />

      {/* EntityHeader — hero block */}
      <div className="bg-bg-container border border-cloud-light rounded-container p-6 flex items-start gap-6">
        {/* Hero monogram */}
        <div className="h-16 w-16 rounded-item bg-cloud-light flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-6 w-48 rounded bg-cloud-light" />
          <div className="h-4 w-32 rounded bg-cloud-light" />
          <div className="h-3 w-64 rounded bg-cloud-light" />
        </div>
        {/* 5-stat row */}
        <div className="flex gap-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="text-center space-y-1">
              <div className="h-6 w-10 rounded bg-cloud-light mx-auto" />
              <div className="h-3 w-14 rounded bg-cloud-light" />
            </div>
          ))}
        </div>
      </div>

      {/* EntityTabs — tab strip */}
      <div className="flex gap-1 border-b border-cloud-light pb-0">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 w-24 rounded-t bg-cloud-light" />
        ))}
      </div>

      {/* 2-col body */}
      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}
      >
        {/* Left column */}
        <div className="space-y-5">
          {/* AISummary */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded bg-cloud-light" />
              <div className="h-4 w-24 rounded bg-cloud-light" />
              <div className="h-3 w-20 rounded bg-cloud-light ml-auto" />
            </div>
            <div className="space-y-2">
              <div className="h-3.5 w-full rounded bg-cloud-light" />
              <div className="h-3.5 w-[92%] rounded bg-cloud-light" />
              <div className="h-3.5 w-[85%] rounded bg-cloud-light" />
              <div className="h-3.5 w-[78%] rounded bg-cloud-light" />
            </div>
          </div>

          {/* CommitmentsCard */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-5 space-y-3">
            <div className="h-4 w-28 rounded bg-cloud-light" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="h-4 w-4 rounded bg-cloud-light flex-shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1">
                  <div className="h-3.5 w-full rounded bg-cloud-light" />
                  <div className="h-3 w-24 rounded bg-cloud-light" />
                </div>
                <div className="h-5 w-16 rounded-badge bg-cloud-light flex-shrink-0" />
              </div>
            ))}
          </div>

          {/* Recent captures list */}
          <div className="bg-bg-container border border-cloud-light rounded-container">
            <div className="px-4 py-3 border-b border-cloud-light flex items-center justify-between">
              <div className="h-4 w-44 rounded bg-cloud-light" />
              <div className="h-6 w-20 rounded bg-cloud-light" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="px-4 py-3 flex items-start gap-3 border-b border-cloud-light last:border-b-0"
              >
                <div className="h-5 w-5 rounded-full bg-cloud-light flex-shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-full max-w-[360px] rounded bg-cloud-light" />
                  <div className="h-3 w-24 rounded bg-cloud-light" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right sidebar */}
        <aside className="flex flex-col gap-4">
          {/* RelationshipGraph */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-36 rounded bg-cloud-light" />
            <div className="h-3 w-44 rounded bg-cloud-light" />
            {/* graph placeholder */}
            <div className="h-40 rounded bg-cloud-light" />
          </div>

          {/* MentionsChart */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-32 rounded bg-cloud-light" />
            <div className="h-28 rounded bg-cloud-light" />
          </div>

          {/* RelatedEntities */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-2">
            <div className="h-4 w-28 rounded bg-cloud-light" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <div className="h-7 w-7 rounded-item bg-cloud-light flex-shrink-0" />
                <div className="flex-1 space-y-1">
                  <div className="h-3 w-28 rounded bg-cloud-light" />
                  <div className="h-2.5 w-16 rounded bg-cloud-light" />
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
