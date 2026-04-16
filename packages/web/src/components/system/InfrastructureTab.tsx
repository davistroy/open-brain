import React from 'react';
import {
  AlertCircle,
  CheckCircle,
  XCircle,
  Server,
  DollarSign,
  HardDrive,
  Database,
  Archive,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  InfrastructureData,
  ContainerHealthEntry,
  BackupLogEntry,
} from '@/lib/types';
import { relativeTime, formatBytes } from './helpers';

export interface InfrastructureTabProps {
  data: InfrastructureData | null;
  loading: boolean;
  error: string | null;
}

function ContainerHealthSection({ entries }: { entries: ContainerHealthEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            <CardTitle className="text-sm">Container Health</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No health check data recorded yet.</p>
        </CardContent>
      </Card>
    );
  }

  // Group by container name, show latest status for each
  const latestByContainer = new Map<string, ContainerHealthEntry>();
  for (const entry of entries) {
    if (!latestByContainer.has(entry.container_name)) {
      latestByContainer.set(entry.container_name, entry);
    }
  }

  const containers = Array.from(latestByContainer.values());

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4" />
          <CardTitle className="text-sm">Container Health</CardTitle>
          <Badge variant="outline" className="text-[10px] ml-auto">{containers.length} containers</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {containers.map((c) => (
            <div key={c.container_name} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                {c.healthy ? (
                  <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                )}
                <span className="text-sm font-mono">{c.container_name}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {c.response_ms != null && <span>{c.response_ms}ms</span>}
                <span>{relativeTime(c.timestamp)}</span>
                {c.error && (
                  <span className="text-destructive truncate max-w-[200px]" title={c.error}>{c.error}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BackupsSection({ entries }: { entries: BackupLogEntry[] }) {
  // Group by type, show latest
  const typeIcons: Record<string, React.ReactNode> = {
    database: <Database className="h-3.5 w-3.5 text-blue-500" />,
    redis: <HardDrive className="h-3.5 w-3.5 text-orange-500" />,
    wiki: <Archive className="h-3.5 w-3.5 text-purple-500" />,
  };

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            <CardTitle className="text-sm">Recent Backups</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No backup records found.</p>
        </CardContent>
      </Card>
    );
  }

  // Show latest 10
  const recent = entries.slice(0, 10);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4" />
          <CardTitle className="text-sm">Recent Backups</CardTitle>
          <Badge variant="outline" className="text-[10px] ml-auto">{entries.length} total</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {recent.map((b) => (
            <div key={b.id} className="flex items-center justify-between py-2 first:pt-0 last:pb-0 gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {typeIcons[b.backup_type] ?? <Archive className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="text-sm capitalize">{b.backup_type}</span>
                {b.status === 'success' ? (
                  <CheckCircle className="h-3 w-3 text-green-500" />
                ) : (
                  <XCircle className="h-3 w-3 text-destructive" />
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                {b.size_bytes != null && <span>{formatBytes(b.size_bytes)}</span>}
                {b.duration_seconds != null && <span>{b.duration_seconds}s</span>}
                {b.pruned_count > 0 && <span className="text-orange-500">{b.pruned_count} pruned</span>}
                <span>{relativeTime(b.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CostSection({ cost }: { cost: InfrastructureData['cost'] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          <CardTitle className="text-sm">LLM Cost Breakdown ({cost.month})</CardTitle>
          <Badge variant="outline" className="text-[10px] ml-auto font-mono">
            ${cost.total_usd.toFixed(2)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {cost.by_model.length === 0 ? (
          <p className="text-sm text-muted-foreground">No LLM usage this month.</p>
        ) : (
          <div className="divide-y">
            {cost.by_model.map((m) => (
              <div key={m.model} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono">{m.model}</span>
                  <span className="text-xs text-muted-foreground">{m.call_count.toLocaleString()} calls</span>
                </div>
                <span className="text-sm font-mono tabular-nums">${m.cost_usd.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function InfrastructureTab({
  data,
  loading,
  error,
}: InfrastructureTabProps) {
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[...Array(3)].map((_, i) => <div key={i} className="h-48 animate-pulse rounded-lg bg-secondary" />)}
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">No infrastructure data available.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Container Health */}
      <ContainerHealthSection entries={data.container_health} />

      {/* Backups */}
      <BackupsSection entries={data.backups} />

      {/* Cost Summary */}
      <CostSection cost={data.cost} />
    </div>
  );
}
