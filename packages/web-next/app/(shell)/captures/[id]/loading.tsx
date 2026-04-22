/**
 * Capture Detail loading skeleton — Cloudscape screen 10.
 * Mirrors the 2-column layout: content left, 340px sidebar right.
 */
export default function CaptureDetailLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* Breadcrumb */}
      <div className="h-3 w-48 rounded bg-cloud-light" />

      {/* 2-col grid */}
      <div
        className="grid gap-6 items-start"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}
      >
        {/* Left column */}
        <div className="flex flex-col gap-5">
          {/* CaptureHeader skeleton */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-6 space-y-4">
            {/* Mono eyebrow */}
            <div className="h-3 w-64 rounded bg-cloud-light" />
            {/* Display-font title */}
            <div className="space-y-2">
              <div className="h-8 w-[85%] rounded bg-cloud-light" />
              <div className="h-8 w-[60%] rounded bg-cloud-light" />
            </div>
            {/* Meta pills */}
            <div className="flex gap-2">
              <div className="h-6 w-20 rounded-badge bg-cloud-light" />
              <div className="h-6 w-28 rounded-badge bg-cloud-light" />
              <div className="h-6 w-24 rounded-badge bg-cloud-light" />
            </div>
          </div>

          {/* AiSummary skeleton */}
          <div
            className="space-y-3 p-5"
            style={{
              background: 'var(--color-book-cloth-50)',
              borderLeft: '3px solid var(--color-cloud-light)',
            }}
          >
            <div className="h-3 w-32 rounded bg-cloud-light" />
            <div className="h-4 w-full rounded bg-cloud-light" />
            <div className="h-4 w-[90%] rounded bg-cloud-light" />
            <div className="h-4 w-[75%] rounded bg-cloud-light" />
          </div>

          {/* TranscriptView skeleton */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-6 space-y-4">
            {/* Card header */}
            <div className="flex justify-between items-center pb-3 border-b border-cloud-light">
              <div className="h-4 w-24 rounded bg-cloud-light" />
              <div className="h-7 w-12 rounded bg-cloud-light" />
            </div>
            {/* Transcript paragraphs */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex gap-4">
                {/* Timestamp */}
                <div className="h-3 w-10 flex-shrink-0 rounded bg-cloud-light mt-1" />
                {/* Text lines */}
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-full rounded bg-cloud-light" />
                  <div className="h-3.5 w-[92%] rounded bg-cloud-light" />
                  <div className="h-3.5 w-[80%] rounded bg-cloud-light" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right sidebar skeleton */}
        <div className="flex flex-col gap-4">
          {/* Entities */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-20 rounded bg-cloud-light" />
            <div className="flex flex-wrap gap-2">
              {[64, 80, 56, 72, 60].map((w, i) => (
                <div key={i} className="h-6 rounded-badge bg-cloud-light" style={{ width: w }} />
              ))}
            </div>
          </div>

          {/* Decisions */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-24 rounded bg-cloud-light" />
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="pl-3 space-y-1" style={{ borderLeft: '2px solid var(--color-cloud-light)' }}>
                <div className="h-3.5 w-full rounded bg-cloud-light" />
                <div className="h-3.5 w-[80%] rounded bg-cloud-light" />
              </div>
            ))}
          </div>

          {/* Commitments */}
          <div className="bg-bg-container border border-cloud-light rounded-container p-4 space-y-3">
            <div className="h-4 w-28 rounded bg-cloud-light" />
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-start gap-2 py-2">
                <div className="h-4 w-16 rounded-badge bg-cloud-light flex-shrink-0" />
                <div className="flex-1 space-y-1">
                  <div className="h-3.5 w-full rounded bg-cloud-light" />
                  <div className="h-3 w-24 rounded bg-cloud-light" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
