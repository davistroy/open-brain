/**
 * Brief reader loading skeleton — Screen 08.
 * Mirrors BriefPage layout:
 *   PageHeader (breadcrumb only) → 3-col grid
 *   [220px BriefToc] [minmax(0, 720px) BriefReader] [280px BriefSources]
 *   gap: 32px, items-start
 */
export default function BriefPageLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader — breadcrumb only */}
      <div className="h-3 w-56 rounded bg-cloud-light" />

      {/* 3-col grid */}
      <div
        className="grid gap-[32px] items-start"
        style={{ gridTemplateColumns: '220px minmax(0, 720px) 280px' }}
      >
        {/* BriefToc — sticky left column */}
        <div className="space-y-3">
          <div className="h-4 w-20 rounded bg-cloud-light" />
          {/* TOC items — varying indentation */}
          {[100, 80, 80, 90, 70, 80, 85, 75].map((w, i) => (
            <div
              key={i}
              className="h-3 rounded bg-cloud-light"
              style={{ width: `${w}%`, marginLeft: i % 3 !== 0 ? '12px' : '0' }}
            />
          ))}
        </div>

        {/* BriefReader — prose body */}
        <div className="bg-bg-container border border-cloud-light rounded-container p-8 space-y-6">
          {/* Article header */}
          <div className="space-y-3 pb-5 border-b border-cloud-light">
            {/* type badge */}
            <div className="h-5 w-20 rounded-badge bg-cloud-light" />
            {/* title */}
            <div className="h-8 w-3/4 rounded bg-cloud-light" />
            {/* subtitle */}
            <div className="h-4 w-1/2 rounded bg-cloud-light" />
            {/* meta row */}
            <div className="flex gap-4 pt-1">
              <div className="h-3 w-24 rounded bg-cloud-light" />
              <div className="h-3 w-20 rounded bg-cloud-light" />
              <div className="h-3 w-16 rounded bg-cloud-light" />
            </div>
          </div>

          {/* Body paragraphs — 3 sections */}
          {Array.from({ length: 3 }).map((_, section) => (
            <div key={section} className="space-y-3">
              {/* Section heading */}
              <div className="h-5 w-48 rounded bg-cloud-light" />
              {/* Paragraph lines */}
              <div className="space-y-2">
                <div className="h-3.5 w-full rounded bg-cloud-light" />
                <div className="h-3.5 w-[97%] rounded bg-cloud-light" />
                <div className="h-3.5 w-[94%] rounded bg-cloud-light" />
                <div className="h-3.5 w-[88%] rounded bg-cloud-light" />
                <div className="h-3.5 w-[72%] rounded bg-cloud-light" />
              </div>
            </div>
          ))}

          {/* Action row */}
          <div className="flex gap-3 pt-2 border-t border-cloud-light">
            <div className="h-8 w-28 rounded bg-cloud-light" />
            <div className="h-8 w-24 rounded bg-cloud-light" />
          </div>
        </div>

        {/* BriefSources — right column */}
        <div className="space-y-4">
          {/* Sources header */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-28 rounded bg-cloud-light" />
            <div className="h-3 w-20 rounded bg-cloud-light" />
            {/* source items */}
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-start gap-2 py-1">
                <div className="h-5 w-5 rounded bg-cloud-light flex-shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1">
                  <div className="h-3 w-full rounded bg-cloud-light" />
                  <div className="h-2.5 w-20 rounded bg-cloud-light" />
                </div>
              </div>
            ))}
          </div>

          {/* Refine options */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-24 rounded bg-cloud-light" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-8 w-full rounded bg-cloud-light" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
