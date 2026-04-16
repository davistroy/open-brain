import { AlertCircle, Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { IntegrationStatus } from '@/lib/types';

export interface IntegrationsSectionProps {
  integrations: IntegrationStatus[];
  loading: boolean;
  error: string | null;
}

export function IntegrationsSection({ integrations, loading, error }: IntegrationsSectionProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Integrations</h2>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && integrations.length === 0 ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <div key={i} className="h-12 animate-pulse rounded bg-secondary" />)}
        </div>
      ) : integrations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No integration data available.</p>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {integrations.map((integration) => (
            <div key={integration.name} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                  integration.status === 'connected' ? 'bg-green-500' : 'bg-red-500'
                }`} />
                <div className="min-w-0">
                  <span className="text-sm font-medium">{integration.name}</span>
                  {integration.detail && (
                    <p className="text-xs text-muted-foreground truncate">{integration.detail}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 text-right">
                {integration.url && (
                  <span className="text-xs text-muted-foreground font-mono hidden sm:inline truncate max-w-[200px]">
                    {integration.url}
                  </span>
                )}
                {integration.last_activity && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground cursor-help">
                          Last: {new Date(integration.last_activity).toLocaleDateString()}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {new Date(integration.last_activity).toLocaleString()}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <Badge
                  variant={integration.status === 'connected' ? 'default' : 'destructive'}
                  className="text-xs"
                >
                  {integration.status}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
