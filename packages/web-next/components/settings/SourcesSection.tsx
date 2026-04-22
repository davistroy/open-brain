'use client';

/**
 * SourcesSection — Settings page "Sources" section (Cloudscape screen 11).
 *
 * Shows all configured integrations from GET /api/v1/config/integrations.
 * Each row: icon, name, description, health status dot, "Configure" button.
 * "Add source" button is a placeholder for M4 OAuth flows.
 *
 * Client component because it needs TanStack Query for data fetching + mutation.
 */

import { useQuery } from '@tanstack/react-query';
import {
  Slack,
  Mic,
  Mail,
  FolderOpen,
  Globe,
  Rss,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { Card, StatusDot, Button } from '@/components/design-system';
import { configApi } from '@/lib/api-client';
import type { Integration, IntegrationStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Integration icon map — keyed by integration id
// ---------------------------------------------------------------------------

const INTEGRATION_ICONS: Record<string, LucideIcon> = {
  slack:    Slack,
  voice:    Mic,
  email:    Mail,
  onedrive: FolderOpen,
  mcp:      Globe,
};

function IntegrationIcon({ id }: { id: string }) {
  const Icon = INTEGRATION_ICONS[id] ?? Rss;
  return (
    <span className="flex-shrink-0 flex items-center justify-center w-8 h-8 border border-cloud-light bg-ivory-dark">
      <Icon size={15} strokeWidth={1.5} className="text-text-body" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Health dot mapping
// ---------------------------------------------------------------------------

function integrationStatusToDot(status: IntegrationStatus): 'success' | 'warning' | 'error' | 'neutral' {
  switch (status) {
    case 'healthy':   return 'success';
    case 'degraded':  return 'warning';
    case 'error':     return 'error';
    case 'unknown':   return 'neutral';
  }
}

function integrationStatusLabel(status: IntegrationStatus): string {
  switch (status) {
    case 'healthy':   return 'Connected';
    case 'degraded':  return 'Degraded';
    case 'error':     return 'Error';
    case 'unknown':   return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Integration row
// ---------------------------------------------------------------------------

function IntegrationRow({ integration }: { integration: Integration }) {
  const dotStatus = integrationStatusToDot(integration.status);
  const dotLabel  = integrationStatusLabel(integration.status);

  return (
    <div className="flex items-center gap-4 py-[12px] border-b border-cloud-light last:border-b-0">
      {/* Icon */}
      <IntegrationIcon id={integration.id} />

      {/* Name + description */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-text-heading leading-[18px]">
          {integration.name}
        </div>
        <div className="text-[12px] text-text-body-secondary font-light mt-[1px] leading-[16px] truncate">
          {integration.description}
          {integration.last_seen && (
            <span className="ml-2 text-text-small">
              · Last seen {new Date(integration.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      </div>

      {/* Health status */}
      <StatusDot status={dotStatus} label={dotLabel} className="shrink-0 mr-2" />

      {/* Configure button */}
      <Button variant="secondary" size="sm" className="shrink-0">
        Configure
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function IntegrationSkeleton() {
  return (
    <div className="flex items-center gap-4 py-[12px] border-b border-cloud-light last:border-b-0">
      <div className="w-8 h-8 bg-cloud-light animate-pulse shrink-0" />
      <div className="flex-1 space-y-[6px]">
        <div className="h-[13px] w-32 bg-cloud-light animate-pulse" />
        <div className="h-[12px] w-48 bg-cloud-light animate-pulse" />
      </div>
      <div className="h-[13px] w-16 bg-cloud-light animate-pulse" />
      <div className="h-[26px] w-20 bg-cloud-light animate-pulse" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

export function SourcesSection() {
  const {
    data,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['config', 'integrations'],
    queryFn: () => configApi.integrations(),
    staleTime: 30_000,
  });

  const integrations = data?.integrations ?? [];

  return (
    <div className="space-y-4">
      {/* Connected integrations card */}
      <Card
        header="Connected sources"
        description="Active integrations that pipe data into your brain."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} strokeWidth={1.5} />}
            disabled
            title="Source OAuth connections are available in M4"
          >
            Add source
          </Button>
        }
        padded={false}
      >
        <div className="px-[18px]">
          {isLoading && (
            <>
              <IntegrationSkeleton />
              <IntegrationSkeleton />
              <IntegrationSkeleton />
            </>
          )}

          {isError && (
            <div className="py-6 text-center text-[12.5px] text-[var(--color-status-error-fg)]">
              Failed to load integrations
              {error instanceof Error ? `: ${error.message}` : ''}.
            </div>
          )}

          {!isLoading && !isError && integrations.length === 0 && (
            <div className="py-6 text-center text-[12.5px] text-text-body-secondary">
              No integrations configured. Add a source to get started.
            </div>
          )}

          {!isLoading && !isError && integrations.map((integration) => (
            <IntegrationRow key={integration.id} integration={integration} />
          ))}
        </div>
      </Card>
    </div>
  );
}
