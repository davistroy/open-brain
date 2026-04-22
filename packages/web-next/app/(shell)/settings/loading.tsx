/**
 * Settings loading skeleton — Cloudscape screen 11.
 * Mirrors SettingsPage layout: PageHeader → 2-column grid (220px sidebar + content).
 * Sidebar shows 8 item placeholders; content shows a card skeleton.
 */
export default function SettingsLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* PageHeader skeleton */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-36 rounded bg-cloud-light" />
        <div className="space-y-2">
          <div className="h-7 w-28 rounded bg-cloud-light" />
          <div className="h-4 w-80 rounded bg-cloud-light" />
        </div>
      </div>

      {/* 2-column settings grid */}
      <div
        className="mt-2"
        style={{
          display: 'grid',
          gridTemplateColumns: '220px minmax(0, 1fr)',
          gap: '0',
          alignItems: 'start',
        }}
      >
        {/* Sidebar skeleton — 8 nav items */}
        <div className="border border-cloud-light overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="px-4 py-[10px] border-b border-cloud-light last:border-b-0 flex items-center gap-3"
            >
              <div className="w-3.5 h-3.5 rounded-full bg-cloud-light shrink-0" />
              <div
                className="h-3 rounded bg-cloud-light"
                style={{ width: `${60 + (i % 3) * 20}px` }}
              />
            </div>
          ))}
        </div>

        {/* Content skeleton */}
        <div className="pl-8">
          <div className="bg-cloud-light border border-cloud-light h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
