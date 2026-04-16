import { AlertCircle } from 'lucide-react';
import { formatUptime } from './utils';

export interface VersionUptimeSectionProps {
  version?: string;
  uptime_s?: number;
  loading: boolean;
  error: string | null;
}

export function VersionUptimeSection({ version, uptime_s, loading, error }: VersionUptimeSectionProps) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Version & Uptime</h2>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && version === undefined && (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-secondary" />)}
        </div>
      )}

      {version !== undefined && (
        <div className="rounded-lg border bg-card divide-y">
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono">{version ?? '\u2014'}</span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Uptime</span>
            <span>{formatUptime(uptime_s)}</span>
          </div>
        </div>
      )}
    </section>
  );
}
