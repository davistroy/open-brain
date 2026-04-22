/**
 * Shell-level loading skeleton — shown during initial navigation
 * before a specific route's loading.tsx takes over.
 * Mirrors the max-w-[1280px] content area.
 */
export default function ShellLoading() {
  return (
    <div className="animate-pulse max-w-[1280px] mx-auto space-y-6">
      {/* PageHeader skeleton */}
      <div className="space-y-2 pb-4 border-b border-cloud-light">
        <div className="h-3 w-32 rounded bg-cloud-light" />
        <div className="h-7 w-64 rounded bg-cloud-light" />
        <div className="h-4 w-96 rounded bg-cloud-light" />
      </div>

      {/* Generic content block */}
      <div className="h-24 rounded-container bg-cloud-light" />
      <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)' }}>
        <div className="space-y-4">
          <div className="h-40 rounded-container bg-cloud-light" />
          <div className="h-56 rounded-container bg-cloud-light" />
        </div>
        <div className="space-y-4">
          <div className="h-40 rounded-container bg-cloud-light" />
          <div className="h-40 rounded-container bg-cloud-light" />
        </div>
      </div>
    </div>
  );
}
