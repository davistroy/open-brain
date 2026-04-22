/**
 * Briefs library loading skeleton — Screen 07.
 * Mirrors BriefsPage layout:
 *   PageHeader → BriefHero (warm paper hero block) → BriefLibrary (filter tabs + 3-col card grid)
 */
export default function BriefsLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-40 rounded bg-cloud-light" />
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <div className="h-7 w-24 rounded bg-cloud-light" />
            <div className="h-4 w-80 rounded bg-cloud-light" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 w-24 rounded bg-cloud-light" />
            <div className="h-7 w-24 rounded bg-cloud-light" />
          </div>
        </div>
      </div>

      {/* BriefHero — warm paper block with metadata + action */}
      <div className="rounded-container border border-cloud-light bg-bg-container p-8 flex flex-col gap-4">
        {/* eyebrow label */}
        <div className="h-3 w-24 rounded bg-cloud-light" />
        {/* title */}
        <div className="h-7 w-72 rounded bg-cloud-light" />
        {/* summary lines */}
        <div className="space-y-2">
          <div className="h-4 w-full max-w-2xl rounded bg-cloud-light" />
          <div className="h-4 w-[85%] max-w-2xl rounded bg-cloud-light" />
          <div className="h-4 w-[70%] max-w-2xl rounded bg-cloud-light" />
        </div>
        {/* meta row + CTA */}
        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-4">
            <div className="h-3 w-24 rounded bg-cloud-light" />
            <div className="h-3 w-20 rounded bg-cloud-light" />
            <div className="h-3 w-16 rounded bg-cloud-light" />
          </div>
          <div className="h-8 w-28 rounded bg-cloud-light" />
        </div>
      </div>

      {/* BriefLibrary — filter row + 3-col card grid */}
      <div className="space-y-4">
        {/* Filter tabs + view toggle */}
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-7 w-20 rounded bg-cloud-light" />
            ))}
          </div>
          <div className="flex gap-1">
            <div className="h-7 w-8 rounded bg-cloud-light" />
            <div className="h-7 w-8 rounded bg-cloud-light" />
          </div>
        </div>

        {/* 3-col card grid */}
        <div className="grid grid-cols-3 gap-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3"
            >
              {/* type badge + date */}
              <div className="flex items-center justify-between">
                <div className="h-5 w-16 rounded-badge bg-cloud-light" />
                <div className="h-3 w-14 rounded bg-cloud-light" />
              </div>
              {/* title */}
              <div className="h-4 w-full rounded bg-cloud-light" />
              <div className="h-4 w-[75%] rounded bg-cloud-light" />
              {/* excerpt */}
              <div className="space-y-1.5">
                <div className="h-3 w-full rounded bg-cloud-light" />
                <div className="h-3 w-[90%] rounded bg-cloud-light" />
              </div>
              {/* footer row */}
              <div className="flex items-center justify-between pt-1">
                <div className="h-3 w-20 rounded bg-cloud-light" />
                <div className="h-3 w-12 rounded bg-cloud-light" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
