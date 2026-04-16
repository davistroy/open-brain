import { Send } from 'lucide-react';
import type { IntegrationStatus } from '@/lib/types';

export interface EmailConfigSectionProps {
  integrations: IntegrationStatus[];
  loading: boolean;
}

export function EmailConfigSection({ integrations, loading }: EmailConfigSectionProps) {
  const inbound = integrations.find(i => i.name === 'Email (Inbound)');
  const outbound = integrations.find(i => i.name === 'Email (Outbound)');

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Email Configuration</h2>
      </div>

      {loading && !inbound && !outbound ? (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Inbound</span>
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${inbound?.status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-muted-foreground">
                {inbound?.detail ?? 'Not configured'}
              </span>
            </div>
          </div>
          <div className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Outbound</span>
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${outbound?.status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-muted-foreground">
                {outbound?.detail ?? 'Not configured'}
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
