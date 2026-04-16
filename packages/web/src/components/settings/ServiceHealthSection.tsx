export interface ServiceHealthSectionProps {
  services?: Record<string, { status: 'up' | 'down' | 'degraded'; latency_ms?: number; models_available?: string[] }>;
  loading: boolean;
}

function StatusDot({ status }: { status: 'up' | 'down' | 'degraded' | 'healthy' | 'unhealthy' | undefined }) {
  if (status === 'up' || status === 'healthy') return <span className="inline-block w-2 h-2 rounded-full bg-green-500" />;
  if (status === 'degraded') return <span className="inline-block w-2 h-2 rounded-full bg-yellow-500" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-red-500" />;
}

export function ServiceHealthSection({ services, loading }: ServiceHealthSectionProps) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Service Health</h2>

      {loading && !services && (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-secondary" />)}
        </div>
      )}

      {services && Object.keys(services).length > 0 ? (
        <div className="rounded-lg border bg-card divide-y">
          {Object.entries(services).map(([name, svc]) => (
            <div key={name} className="px-4 py-3 flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <StatusDot status={svc.status} />
                <span className="capitalize">{name === 'llm' ? 'LLM' : name}</span>
              </div>
              <div className="flex items-center gap-3 text-muted-foreground">
                {svc.latency_ms !== undefined && <span>{svc.latency_ms}ms</span>}
                {svc.models_available && svc.models_available.length > 0 && (
                  <span className="text-xs">{svc.models_available.slice(0, 3).join(', ')}{svc.models_available.length > 3 ? '\u2026' : ''}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : !loading && (
        <p className="text-sm text-muted-foreground">No service data available.</p>
      )}
    </section>
  );
}
